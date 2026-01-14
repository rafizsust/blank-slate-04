import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { GoogleGenerativeAI } from "https://esm.sh/@google/generative-ai@0.21.0";
import { crypto } from "https://deno.land/std@0.168.0/crypto/mod.ts";
import { 
  getActiveGeminiKeysForModel, 
  markKeyQuotaExhausted,
  isQuotaExhaustedError
} from "../_shared/apiKeyQuotaUtils.ts";
import { getFromR2 } from "../_shared/r2Client.ts";

/**
 * ASYNC Speaking Evaluation Edge Function
 * 
 * Uses Google File API for audio uploads to avoid base64 token bloat (stack overflow).
 * Audio files are uploaded to Google's servers, then URIs are passed to Gemini.
 * 
 * Returns 202 Accepted IMMEDIATELY. User gets instant "submitted" feedback.
 * Actual evaluation runs in background via EdgeRuntime.waitUntil.
 * Results are saved to DB and user is notified via Supabase Realtime.
 */

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

// Model priority: gemini-2.5-flash first (best quality), then 2.0-flash fallback
const GEMINI_MODELS = [
  'gemini-2.5-flash',
  'gemini-2.0-flash',
];

// Custom error class for quota exhaustion / rate limiting
class QuotaError extends Error {
  permanent: boolean;
  retryAfterSeconds?: number;

  constructor(message: string, opts: { permanent: boolean; retryAfterSeconds?: number }) {
    super(message);
    this.name = 'QuotaError';
    this.permanent = opts.permanent;
    this.retryAfterSeconds = opts.retryAfterSeconds;
  }
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Exponential backoff with jitter for rate limit handling
 * @param attempt - Current attempt number (0-indexed)
 * @param baseDelayMs - Base delay in milliseconds (default 1000ms)
 * @param maxDelayMs - Maximum delay in milliseconds (default 60000ms)
 * @returns Delay in milliseconds with jitter
 */
function exponentialBackoffWithJitter(attempt: number, baseDelayMs = 1000, maxDelayMs = 60000): number {
  // Exponential backoff: 1s, 2s, 4s, 8s, 16s, 32s, capped at maxDelay
  const exponentialDelay = Math.min(baseDelayMs * Math.pow(2, attempt), maxDelayMs);
  // Add jitter: random value between 0 and 50% of the delay
  const jitter = Math.random() * exponentialDelay * 0.5;
  return Math.round(exponentialDelay + jitter);
}

function extractRetryAfterSeconds(err: any): number | undefined {
  const msg = String(err?.message || err || '');
  const m1 = msg.match(/retryDelay"\s*:\s*"(\d+)s"/i);
  if (m1) return Math.max(0, Number(m1[1]));
  const m2 = msg.match(/retry\s+in\s+([0-9.]+)s/i);
  if (m2) return Math.max(0, Math.ceil(Number(m2[1])));
  return undefined;
}

function isPermanentQuotaExhausted(err: any): boolean {
  const msg = String(err?.message || err || '').toLowerCase();
  if (msg.includes('check your plan') || msg.includes('billing')) return true;
  if (msg.includes('limit: 0')) return true;
  if (msg.includes('per day') && !msg.includes('retry')) return true;
  return false;
}

// Declare EdgeRuntime for background processing
declare const EdgeRuntime: { waitUntil?: (promise: Promise<void>) => void } | undefined;

interface EvaluationRequest {
  testId: string;
  filePaths: Record<string, string>;
  durations?: Record<string, number>;
  topic?: string;
  difficulty?: string;
  fluencyFlag?: boolean;
  retryJobId?: string; // If this is a retry, use existing job instead of creating new one
}

// Upload audio to Google File API using direct HTTP (Deno-compatible)
async function uploadToGoogleFileAPI(
  apiKey: string,
  audioBytes: Uint8Array,
  fileName: string,
  mimeType: string
): Promise<{ uri: string; mimeType: string }> {
  console.log(`[evaluate-speaking-async] Uploading ${fileName} to Google File API (${audioBytes.length} bytes)...`);
  
  // Google File API uses resumable upload protocol
  const initiateUrl = `https://generativelanguage.googleapis.com/upload/v1beta/files?key=${apiKey}`;
  
  const metadata = {
    file: {
      displayName: fileName,
    }
  };
  
  const initiateResponse = await fetch(initiateUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Upload-Protocol': 'resumable',
      'X-Goog-Upload-Command': 'start',
      'X-Goog-Upload-Header-Content-Length': String(audioBytes.length),
      'X-Goog-Upload-Header-Content-Type': mimeType,
    },
    body: JSON.stringify(metadata),
  });
  
  if (!initiateResponse.ok) {
    const errorText = await initiateResponse.text();
    throw new Error(`Failed to initiate upload: ${initiateResponse.status} - ${errorText}`);
  }
  
  const uploadUrl = initiateResponse.headers.get('X-Goog-Upload-URL');
  if (!uploadUrl) {
    throw new Error('No upload URL returned from Google File API');
  }
  
  // Step 2: Upload the actual bytes
  const uploadResponse = await fetch(uploadUrl, {
    method: 'PUT',
    headers: {
      'Content-Length': String(audioBytes.length),
      'X-Goog-Upload-Offset': '0',
      'X-Goog-Upload-Command': 'upload, finalize',
    },
    body: audioBytes.buffer as ArrayBuffer,
  });
  
  if (!uploadResponse.ok) {
    const errorText = await uploadResponse.text();
    throw new Error(`Failed to upload file: ${uploadResponse.status} - ${errorText}`);
  }
  
  const result = await uploadResponse.json();
  
  if (!result.file?.uri) {
    throw new Error('No file URI returned from Google File API');
  }
  
  console.log(`[evaluate-speaking-async] Uploaded ${fileName}: ${result.file.uri}`);
  
  return {
    uri: result.file.uri,
    mimeType: result.file.mimeType || mimeType,
  };
}

serve(async (req) => {
  console.log(`[evaluate-speaking-async] Request at ${new Date().toISOString()}`);
  
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseAnonKey = Deno.env.get('SUPABASE_ANON_KEY')!;
    const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const appEncryptionKey = Deno.env.get('app_encryption_key')!;

    const supabaseClient = createClient(supabaseUrl, supabaseAnonKey, {
      global: { headers: { Authorization: req.headers.get('Authorization')! } },
    });

    const supabaseService = createClient(supabaseUrl, supabaseServiceKey);

    // Authenticate user
    const { data: { user }, error: authError } = await supabaseClient.auth.getUser();
    if (authError || !user) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const body: EvaluationRequest = await req.json();
    const { testId, filePaths, durations, topic, difficulty, fluencyFlag, retryJobId } = body;

    if (!testId || !filePaths || Object.keys(filePaths).length === 0) {
      return new Response(JSON.stringify({ error: 'Missing testId or filePaths' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    let job: any;

    // Check if this is a retry (reuse existing job record)
    if (retryJobId) {
      console.log(`[evaluate-speaking-async] Retry mode - reusing job ${retryJobId}`);
      
      const { data: existingJob, error: fetchError } = await supabaseService
        .from('speaking_evaluation_jobs')
        .select('*')
        .eq('id', retryJobId)
        .single();

      if (fetchError || !existingJob) {
        console.error('[evaluate-speaking-async] Failed to fetch retry job:', fetchError);
        return new Response(JSON.stringify({ error: 'Retry job not found' }), {
          status: 404,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      // Update status to processing
      await supabaseService
        .from('speaking_evaluation_jobs')
        .update({ status: 'processing', updated_at: new Date().toISOString() })
        .eq('id', retryJobId);

      job = existingJob;
    } else {
      console.log(`[evaluate-speaking-async] Creating new job for test ${testId}, ${Object.keys(filePaths).length} files`);

      // CANCEL any pending/processing jobs for this user and test to prevent duplicate evaluations
      const { data: existingJobs } = await supabaseService
        .from('speaking_evaluation_jobs')
        .select('id, status')
        .eq('user_id', user.id)
        .eq('test_id', testId)
        .in('status', ['pending', 'processing']);

      if (existingJobs && existingJobs.length > 0) {
        console.log(`[evaluate-speaking-async] Cancelling ${existingJobs.length} existing jobs for test ${testId}`);
        await supabaseService
          .from('speaking_evaluation_jobs')
          .update({
            status: 'failed',
            last_error: 'Cancelled: User submitted a new evaluation request.',
            updated_at: new Date().toISOString(),
          })
          .eq('user_id', user.id)
          .eq('test_id', testId)
          .in('status', ['pending', 'processing']);
      }

      // Create job record in database (triggers realtime for frontend)
      const { data: newJob, error: jobError } = await supabaseService
        .from('speaking_evaluation_jobs')
        .insert({
          user_id: user.id,
          test_id: testId,
          status: 'pending',
          file_paths: filePaths,
          durations: durations || {},
          topic,
          difficulty,
          fluency_flag: fluencyFlag || false,
        })
        .select()
        .single();

      if (jobError) {
        console.error('[evaluate-speaking-async] Job creation failed:', jobError);
        return new Response(JSON.stringify({ error: 'Failed to create job' }), {
          status: 500,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      job = newJob;
    }

    console.log(`[evaluate-speaking-async] Job ${retryJobId ? 'retry' : 'created'}: ${job.id}`);

    // Background processing function
    const processInBackground = async () => {
      try {
        await runEvaluation(job.id, user.id, supabaseService, supabaseClient, appEncryptionKey);
      } catch (err) {
        console.error('[evaluate-speaking-async] Background error:', err);
        await supabaseService
          .from('speaking_evaluation_jobs')
          .update({
            status: 'failed',
            last_error: err instanceof Error ? err.message : 'Unknown error',
          })
          .eq('id', job.id);
      }
    };

    // Watchdog: if a job gets stuck, mark it as failed
    const watchdog = async () => {
      const WATCHDOG_MS = 12 * 60 * 1000;
      await new Promise((r) => setTimeout(r, WATCHDOG_MS));

      const { data: current } = await supabaseService
        .from('speaking_evaluation_jobs')
        .select('status, updated_at')
        .eq('id', job.id)
        .maybeSingle();

      if (!current) return;
      if (current.status === 'completed' || current.status === 'failed') return;

      console.warn('[evaluate-speaking-async] Watchdog firing: job still not terminal, marking failed', job.id);
      await supabaseService
        .from('speaking_evaluation_jobs')
        .update({
          status: 'failed',
          last_error: 'Evaluation timed out in background processing. Please resubmit.',
        })
        .eq('id', job.id);
    };

    // Use EdgeRuntime.waitUntil for true async background processing
    if (typeof EdgeRuntime !== 'undefined' && EdgeRuntime.waitUntil) {
      console.log('[evaluate-speaking-async] Using EdgeRuntime.waitUntil');
      EdgeRuntime.waitUntil(processInBackground());
      EdgeRuntime.waitUntil(watchdog());
    } else {
      console.log('[evaluate-speaking-async] EdgeRuntime not available, running async');
      processInBackground().catch(console.error);
      watchdog().catch(console.error);
    }

    // Return 202 IMMEDIATELY - user gets instant feedback
    return new Response(
      JSON.stringify({
        success: true,
        jobId: job.id,
        status: 'pending',
        message: 'Evaluation submitted. You will be notified when results are ready.',
      }),
      {
        status: 202,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      },
    );

  } catch (error: any) {
    console.error('[evaluate-speaking-async] Error:', error);
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});

// Main evaluation logic (runs in background)
async function runEvaluation(
  jobId: string,
  userId: string,
  supabaseService: any,
  supabaseClient: any,
  appEncryptionKey: string
): Promise<void> {
  console.log(`[runEvaluation] Starting job ${jobId}`);
  
  // Mark as processing
  await supabaseService
    .from('speaking_evaluation_jobs')
    .update({ status: 'processing' })
    .eq('id', jobId);

  // Get job details
  const { data: job } = await supabaseService
    .from('speaking_evaluation_jobs')
    .select('*')
    .eq('id', jobId)
    .single();

  if (!job) throw new Error('Job not found');

  const { test_id, file_paths, durations, topic, difficulty, fluency_flag } = job;

  // Get test payload
  const { data: testRow } = await supabaseService
    .from('ai_practice_tests')
    .select('payload, topic, difficulty, preset_id')
    .eq('id', test_id)
    .eq('user_id', userId)
    .maybeSingle();

  if (!testRow) throw new Error('Test not found');

  let payload = testRow.payload as any || {};
  
  // Fetch preset content if needed
  if (testRow.preset_id && (!payload.speakingParts && !payload.part1)) {
    const { data: presetData } = await supabaseService
      .from('generated_test_audio')
      .select('content_payload')
      .eq('id', testRow.preset_id)
      .maybeSingle();
    
    if (presetData?.content_payload) {
      payload = presetData.content_payload;
    }
  }

  // Build segment metadata for completeness checking
  const parts = Array.isArray(payload?.speakingParts) ? payload.speakingParts : [];
  const questionById = new Map<string, { partNumber: 1 | 2 | 3; questionNumber: number; questionText: string }>();
  for (const p of parts) {
    const partNumber = Number(p?.part_number) as 1 | 2 | 3;
    if (partNumber !== 1 && partNumber !== 2 && partNumber !== 3) continue;
    const qs = Array.isArray(p?.questions) ? p.questions : [];
    for (const q of qs) {
      const id = String(q?.id || '');
      if (!id) continue;
      questionById.set(id, {
        partNumber,
        questionNumber: Number(q?.question_number),
        questionText: String(q?.question_text || ''),
      });
    }
  }

  const segmentMetaByKey = new Map<
    string,
    { segmentKey: string; partNumber: 1 | 2 | 3; questionNumber: number; questionText: string }
  >();

  for (const segmentKey of Object.keys(file_paths as Record<string, string>)) {
    const m = String(segmentKey).match(/^part([123])\-q(.+)$/);
    if (!m) continue;
    const partNumber = Number(m[1]) as 1 | 2 | 3;
    const questionId = m[2];
    const q = questionById.get(questionId);
    if (!q) continue;
    segmentMetaByKey.set(segmentKey, {
      segmentKey,
      partNumber,
      questionNumber: q.questionNumber,
      questionText: q.questionText,
    });
  }

  const orderedSegments = Array.from(segmentMetaByKey.values()).sort((a, b) => {
    if (a.partNumber !== b.partNumber) return a.partNumber - b.partNumber;
    return a.questionNumber - b.questionNumber;
  });

  // ============ DOWNLOAD FILES FROM R2 IN CORRECT ORDER ============
  // CRITICAL: Files MUST be downloaded and uploaded to Google File API in the EXACT same order
  // as orderedSegments. Otherwise Gemini will mismatch transcripts to questions.
  console.log('[runEvaluation] Downloading audio files from R2 IN ORDER OF orderedSegments...');
  
  const audioFiles: { key: string; bytes: Uint8Array; mimeType: string }[] = [];
  
  // Build a lookup map for file_paths
  const filePathsMap = file_paths as Record<string, string>;
  
  // Download in the EXACT order of orderedSegments to guarantee consistency
  for (const segment of orderedSegments) {
    const audioKey = segment.segmentKey;
    const r2Path = filePathsMap[audioKey];
    
    if (!r2Path) {
      console.warn(`[runEvaluation] No R2 path for segment: ${audioKey}, skipping`);
      continue;
    }
    
    try {
      console.log(`[runEvaluation] Downloading Part ${segment.partNumber} Q${segment.questionNumber}: ${r2Path}`);
      const result = await getFromR2(r2Path);
      if (!result.success || !result.bytes) {
        throw new Error(`Failed to download: ${result.error}`);
      }
      
      const ext = r2Path.split('.').pop()?.toLowerCase() || 'webm';
      const mimeType = ext === 'mp3' ? 'audio/mpeg' : 'audio/webm';
      
      audioFiles.push({ key: audioKey, bytes: result.bytes, mimeType });
      console.log(`[runEvaluation] Downloaded [${audioFiles.length}] Part ${segment.partNumber} Q${segment.questionNumber}: ${r2Path} (${result.bytes.length} bytes)`);
    } catch (e) {
      console.error(`[runEvaluation] Download error for ${audioKey}:`, e);
    }
  }

  if (audioFiles.length === 0) {
    throw new Error('No audio files could be downloaded from R2');
  }

  console.log(`[runEvaluation] Downloaded ${audioFiles.length} audio files from R2`);

  // ============ BUILD API KEY QUEUE ============
  interface KeyCandidate {
    key: string;
    keyId: string | null;
    isUserProvided: boolean;
  }

  const keyQueue: KeyCandidate[] = [];

  // 1. Try user's key first
  const { data: userSecret } = await supabaseClient
    .from('user_secrets')
    .select('encrypted_value')
    .eq('user_id', userId)
    .eq('secret_name', 'GEMINI_API_KEY')
    .single();

  if (userSecret?.encrypted_value && appEncryptionKey) {
    try {
      const userKey = await decryptKey(userSecret.encrypted_value, appEncryptionKey);
      keyQueue.push({ key: userKey, keyId: null, isUserProvided: true });
    } catch (e) {
      console.warn('[runEvaluation] Failed to decrypt user API key:', e);
    }
  }

  // 2. Add admin keys from database pool
  const dbApiKeys = await getActiveGeminiKeysForModel(supabaseService, 'flash_2_5');
  for (const dbKey of dbApiKeys) {
    keyQueue.push({ key: dbKey.key_value, keyId: dbKey.id, isUserProvided: false });
  }

  if (keyQueue.length === 0) {
    throw new Error('No API keys available');
  }

  console.log(`[runEvaluation] Key queue: ${keyQueue.length} keys (${keyQueue.filter(k => k.isUserProvided).length} user, ${keyQueue.filter(k => !k.isUserProvided).length} admin)`);

  // Build the evaluation prompt
  const prompt = buildPrompt(
    payload,
    topic || testRow.topic,
    difficulty || testRow.difficulty,
    fluency_flag,
    orderedSegments,
  );

  // ============ EVALUATION LOOP WITH KEY ROTATION ============
  let evaluationResult: any = null;
  let usedModel: string | null = null;

  for (const candidateKey of keyQueue) {
    if (evaluationResult) break;
    
    console.log(`[runEvaluation] Trying key ${candidateKey.isUserProvided ? '(user)' : `(admin: ${candidateKey.keyId})`}`);

    try {
      // Initialize GenAI with this key
      const genAI = new GoogleGenerativeAI(candidateKey.key);

      // ============ UPLOAD FILES TO GOOGLE FILE API ============
      const fileUris: Array<{ fileData: { mimeType: string; fileUri: string } }> = [];
      
      console.log(`[runEvaluation] Uploading ${audioFiles.length} files to Google File API...`);
      
      for (const audioFile of audioFiles) {
        try {
          const uploadResult = await uploadToGoogleFileAPI(
            candidateKey.key,
            audioFile.bytes,
            `${audioFile.key}.webm`,
            audioFile.mimeType
          );
          
          fileUris.push({
            fileData: {
              mimeType: uploadResult.mimeType,
              fileUri: uploadResult.uri,
            }
          });
        } catch (uploadError: any) {
          console.error(`[runEvaluation] Failed to upload ${audioFile.key}:`, uploadError?.message);
          throw uploadError;
        }
      }
      
      console.log(`[runEvaluation] Successfully uploaded ${fileUris.length} files to Google File API`);

      // Try each model in priority order
      for (const modelName of GEMINI_MODELS) {
        if (evaluationResult) break;

        console.log(`[runEvaluation] Attempting evaluation with model: ${modelName}`);
        
        const model = genAI.getGenerativeModel({ 
          model: modelName,
          generationConfig: {
            temperature: 0.3,
            maxOutputTokens: 65000,
          },
        });

        // Build content with file URIs (NOT base64 - avoids stack overflow)
        const contentParts: any[] = [
          ...fileUris, // File URIs first
          { text: prompt } // Then the prompt
        ];

        // Retry with exponential backoff and jitter (max 4 attempts)
        const MAX_RETRIES = 4;
        for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
          try {
            const response = await model.generateContent({ contents: [{ role: 'user', parts: contentParts }] });
            const text = response.response?.text?.() || '';

            if (!text) {
              console.warn(`[runEvaluation] Empty response from ${modelName}`);
              break;
            }

            console.log(`[runEvaluation] Successfully received response from model: ${modelName}`);

            const parsed = parseJson(text);
            if (parsed) {
              evaluationResult = parsed;
              usedModel = modelName;
              console.log(`[runEvaluation] Success with ${modelName}`);
              break;
            } else {
              console.warn(`[runEvaluation] Failed to parse JSON from ${modelName}`);
              break;
            }
          } catch (err: any) {
            const errMsg = String(err?.message || '');
            console.error(`[runEvaluation] Model ${modelName} failed (attempt ${attempt + 1}/${MAX_RETRIES}):`, errMsg.slice(0, 300));

            // Check for permanent quota exhaustion (billing/plan limit)
            if (isPermanentQuotaExhausted(err)) {
              // Mark pool key as exhausted permanently
              if (!candidateKey.isUserProvided && candidateKey.keyId) {
                await markKeyQuotaExhausted(supabaseService, candidateKey.keyId, 'flash_2_5');
              }
              // Break out of retry loop and model loop - try next key
              throw new QuotaError(errMsg, { permanent: true });
            }

            // Check for temporary rate limit (429 errors)
            if (isQuotaExhaustedError(errMsg)) {
              // Check if there's a specific retry-after header value
              const retryAfterFromError = extractRetryAfterSeconds(err);
              
              if (attempt < MAX_RETRIES - 1) {
                // Use exponential backoff with jitter, or specific retry-after if available
                const backoffDelay = retryAfterFromError 
                  ? Math.min(retryAfterFromError * 1000, 60000)
                  : exponentialBackoffWithJitter(attempt, 2000, 60000);
                
                console.log(`[runEvaluation] Rate limited (429), retrying in ${Math.round(backoffDelay / 1000)}s (attempt ${attempt + 1}/${MAX_RETRIES})...`);
                await sleep(backoffDelay);
                continue;
              } else {
                // Exhausted retries for this key, try next key
                console.log(`[runEvaluation] Rate limit retries exhausted for this key, trying next...`);
                throw new QuotaError(errMsg, { permanent: false });
              }
            }

            // For other transient errors, apply backoff too
            if (attempt < MAX_RETRIES - 1) {
              const backoffDelay = exponentialBackoffWithJitter(attempt, 1000, 30000);
              console.log(`[runEvaluation] Transient error, retrying in ${Math.round(backoffDelay / 1000)}s...`);
              await sleep(backoffDelay);
              continue;
            }

            // Not retryable after max attempts, try next model
            break;
          }
        }
      }
    } catch (keyError: any) {
      if (keyError instanceof QuotaError) {
        console.log(`[runEvaluation] Key quota exhausted, trying next key...`);
        continue;
      }
      console.error(`[runEvaluation] Key error:`, keyError?.message);
      // Try next key
    }
  }

  if (!evaluationResult) {
    throw new Error('Evaluation failed: all models/keys exhausted');
  }

  // Validate model answer lengths - Part 2 should be at least 100 words
  const modelAnswers = evaluationResult.modelAnswers || [];
  for (const answer of modelAnswers) {
    if (answer.partNumber === 2 && answer.modelAnswer) {
      const wordCount = String(answer.modelAnswer).split(/\s+/).filter(Boolean).length;
      if (wordCount < 100) {
        console.warn(`[runEvaluation] Part 2 model answer too short (${wordCount} words)`);
      }
    }
  }

  // Calculate band score
  const overallBand = evaluationResult.overall_band || calculateBand(evaluationResult);

  // Build public audio URLs
  const publicBase = (Deno.env.get('R2_PUBLIC_URL') || '').replace(/\/$/, '');
  const audioUrls: Record<string, string> = {};
  if (publicBase) {
    for (const [k, r2Key] of Object.entries(file_paths as Record<string, string>)) {
      audioUrls[k] = `${publicBase}/${String(r2Key).replace(/^\//, '')}`;
    }
  }

  // Save to ai_practice_results
  const transcriptsByPart = evaluationResult?.transcripts_by_part || {};
  const transcriptsByQuestion = evaluationResult?.transcripts_by_question || {};

  const { data: resultRow, error: saveError } = await supabaseService
    .from('ai_practice_results')
    .insert({
      test_id,
      user_id: userId,
      module: 'speaking',
      score: Math.round(overallBand * 10),
      band_score: overallBand,
      total_questions: audioFiles.length,
      time_spent_seconds: durations
        ? Math.round(Object.values(durations as Record<string, number>).reduce((a, b) => a + b, 0))
        : 60,
      question_results: evaluationResult,
      answers: {
        audio_urls: audioUrls,
        transcripts_by_part: transcriptsByPart,
        transcripts_by_question: transcriptsByQuestion,
        file_paths,
      },
      completed_at: new Date().toISOString(),
    })
    .select()
    .single();

  if (saveError) {
    console.error('[runEvaluation] Save error:', saveError);
  }

  // Mark job as completed - triggers Realtime notification
  await supabaseService
    .from('speaking_evaluation_jobs')
    .update({
      status: 'completed',
      result_id: resultRow?.id,
      completed_at: new Date().toISOString(),
    })
    .eq('id', jobId);

  console.log(`[runEvaluation] Evaluation complete, band: ${overallBand}, result_id: ${resultRow?.id}`);
}

// Helper functions
async function decryptKey(encrypted: string, appKey: string): Promise<string> {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const keyData = encoder.encode(appKey).slice(0, 32);
  const cryptoKey = await crypto.subtle.importKey('raw', keyData, { name: 'AES-GCM' }, false, ['decrypt']);
  const bytes = Uint8Array.from(atob(encrypted), c => c.charCodeAt(0));
  const decrypted = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: bytes.slice(0, 12) }, cryptoKey, bytes.slice(12));
  return decoder.decode(decrypted);
}

function buildPrompt(
  payload: any,
  topic: string | undefined,
  difficulty: string | undefined,
  fluencyFlag: boolean | undefined,
  orderedSegments: Array<{ segmentKey: string; partNumber: 1 | 2 | 3; questionNumber: number; questionText: string }>,
): string {
  const parts = Array.isArray(payload?.speakingParts) ? payload.speakingParts : [];
  const questions = parts
    .flatMap((p: any) =>
      (Array.isArray(p?.questions)
        ? p.questions.map((q: any) => ({
            id: String(q?.id || ''),
            part_number: Number(p?.part_number),
            question_number: Number(q?.question_number),
            question_text: String(q?.question_text || ''),
          }))
        : []),
    )
    .filter((q: any) => q.part_number === 1 || q.part_number === 2 || q.part_number === 3);

  const questionJson = JSON.stringify(questions);
  const segmentJson = JSON.stringify(orderedSegments);
  
  const includedParts = [...new Set(orderedSegments.map(s => s.partNumber))].sort();
  const partsDescription = includedParts.length === 1 
    ? `Part ${includedParts[0]} only` 
    : `Parts ${includedParts.join(', ')}`;

  const numQ = orderedSegments.length;

  return `You are a CERTIFIED SENIOR IELTS Speaking Examiner with 20+ years of examination experience.
You MUST evaluate exactly as an official IELTS examiner would during a real exam.
Return ONLY valid JSON, no markdown, no explanations outside JSON.

CONTEXT: Topic: ${topic || 'General'}, Difficulty: ${difficulty || 'Medium'}, Parts: ${partsDescription}, Questions: ${numQ}
${fluencyFlag ? '⚠️ Part 2 speaking time under 80 seconds - apply appropriate fluency penalty per IELTS guidelines.' : ''}

══════════════════════════════════════════════════════════════
AUDIO-TO-QUESTION MAPPING - FOLLOW THIS EXACTLY (NO DEVIATION!)
══════════════════════════════════════════════════════════════
The audio files are provided IN STRICT ORDER corresponding to this segment map:
${segmentJson}

Audio file 1 = segment_map index 0
Audio file 2 = segment_map index 1
Audio file 3 = segment_map index 2
... and so on.

DO NOT reorder, swap, or guess which audio belongs to which question.
The mapping is FIXED and SEQUENTIAL. Transcript audio file N to segment_map[N].

══════════════════════════════════════════════════════════════
OFFICIAL IELTS BAND DESCRIPTOR STANDARDS (MANDATORY)
══════════════════════════════════════════════════════════════

FLUENCY AND COHERENCE (FC):
- Band 9: Speaks fluently with only rare repetition or self-correction; hesitation is content-related
- Band 7: Speaks at length without noticeable effort or loss of coherence; may demonstrate language-related hesitation at times
- Band 5: Usually maintains flow of speech but uses repetition, self-correction and/or slow speech
- Band 4: Cannot respond without noticeable pauses; may speak slowly with frequent repetition

LEXICAL RESOURCE (LR):
- Band 9: Uses vocabulary with full flexibility and precision; uses idiomatic language naturally
- Band 7: Uses vocabulary resource flexibly; uses some less common/idiomatic vocabulary skillfully
- Band 5: Manages to talk about topics but uses limited vocabulary; may make noticeable pauses to search for words
- Band 4: Uses basic vocabulary which may be used repetitively or inappropriate for the topic

GRAMMATICAL RANGE AND ACCURACY (GRA):
- Band 9: Uses a full range of structures naturally and appropriately; produces consistently accurate structures
- Band 7: Uses a range of complex structures with some flexibility; frequently produces error-free sentences
- Band 5: Produces basic sentence forms with reasonable accuracy; uses a limited range of more complex structures
- Band 4: Produces basic sentence forms and some correct simple sentences but subordinate structures are rare

PRONUNCIATION (P):
- Band 9: Uses a full range of pronunciation features with precision and subtlety; sustains flexible use throughout
- Band 7: Shows all positive features of Band 6 and some of Band 8; may still be influenced by L1
- Band 5: Shows all positive features of Band 4 but some features of Band 6; may mispronounce individual words
- Band 4: Uses a limited range of pronunciation features; mispronunciations are frequent

SCORING GUIDELINES (STRICT IELTS STANDARDS):
- Short/minimal responses (under 15 words): Maximum Band 4.0-4.5
- Off-topic/irrelevant content: Severe penalty to FC (1-2 bands below actual fluency)
- Excessive repetition of words/phrases: Penalize LR appropriately
- No response or "I don't know" only: Band 1.0-2.0
- Part 2 must be evaluated holistically - content quality matters more than word count
- If candidate fully addresses cue card with excellent vocabulary but speaks concisely, do NOT penalize

HOLISTIC EVALUATION (CRITICAL):
- Evaluate the QUALITY of response, not just quantity
- A brilliant 200-word Part 2 answer that fully addresses the topic can score Band 8+
- A rambling 400-word Part 2 that lacks coherence may score Band 5-6
- Focus on: appropriateness, accuracy, range, and naturalness

MODEL ANSWERS WORD COUNT GUIDELINES:
- Part 1: ~75 words (natural conversational response)
- Part 2: ~250-300 words (comprehensive long-turn with all cue card points)
- Part 3: ~100-150 words (reasoned discussion response)

MANDATORY OUTPUT REQUIREMENTS:
1. Transcribe ALL ${numQ} audio files ACCURATELY in the EXACT order they appear
2. Each modelAnswers entry MUST have the correct segment_key matching the input
3. Include band scores (using "band" key) for ALL 4 criteria (1.0-9.0 range)
4. Overall band = weighted average: Part 2 × 2.0, Part 3 × 1.5, Part 1 × 1.0

EXACT JSON SCHEMA:
{
  "overall_band": 6.0,
  "criteria": {
    "fluency_coherence": {"band": 6.0, "feedback": "...", "strengths": [...], "weaknesses": [...], "suggestions": [...]},
    "lexical_resource": {"band": 6.0, "feedback": "...", "strengths": [...], "weaknesses": [...], "suggestions": [...]},
    "grammatical_range": {"band": 5.5, "feedback": "...", "strengths": [...], "weaknesses": [...], "suggestions": [...]},
    "pronunciation": {"band": 6.0, "feedback": "...", "strengths": [...], "weaknesses": [...], "suggestions": [...]}
  },
  "summary": "Overall performance summary highlighting key strengths and areas for improvement",
  "lexical_upgrades": [{"original": "word", "upgraded": "better_word", "context": "usage example"}],
  "part_analysis": [{"part_number": 1, "performance_notes": "...", "key_moments": [...], "areas_for_improvement": [...]}],
  "improvement_priorities": ["Priority 1: ...", "Priority 2: ..."],
  "transcripts_by_part": {"1": "Full Part 1 transcript...", "2": "Full Part 2 transcript...", "3": "Full Part 3 transcript..."},
  "transcripts_by_question": {
    "1": [{"segment_key": "part1-q...", "question_number": 1, "question_text": "...", "transcript": "exact transcription"}],
    "2": [{"segment_key": "part2-q...", "question_number": 1, "question_text": "...", "transcript": "exact transcription"}],
    "3": [{"segment_key": "part3-q...", "question_number": 1, "question_text": "...", "transcript": "exact transcription"}]
  },
  "modelAnswers": [
    {
      "segment_key": "part1-q...",
      "partNumber": 1,
      "questionNumber": 1,
      "question": "Question text",
      "candidateResponse": "EXACT transcript of what candidate said",
      "estimatedBand": 5.5,
      "targetBand": 6,
      "modelAnswer": "Model answer following word count guidelines",
      "whyItWorks": ["Uses topic-specific vocabulary", "Clear structure"],
      "keyImprovements": ["Specific improvement 1", "Specific improvement 2"]
    }
  ]
}

INPUT DATA (${numQ} questions to evaluate):
questions_json: ${questionJson}
segment_map_json (AUDIO FILES ARE IN THIS EXACT ORDER): ${segmentJson}

FINAL REMINDER: Audio file order is FIXED. Do NOT swap transcripts between questions. Return exactly ${numQ} modelAnswers entries with correct segment_keys.`;
}

function parseJson(text: string): any {
  try { return JSON.parse(text); } catch {}
  const match = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (match) try { return JSON.parse(match[1].trim()); } catch {}
  const objMatch = text.match(/\{[\s\S]*\}/);
  if (objMatch) try { return JSON.parse(objMatch[0]); } catch {}
  return null;
}

function calculateBand(result: any): number {
  const c = result.criteria;
  if (!c) return 6.0;
  const scores = [
    c.fluency_coherence?.band,
    c.lexical_resource?.band,
    c.grammatical_range?.band,
    c.pronunciation?.band,
  ].filter(s => typeof s === 'number');
  
  if (scores.length === 0) return 6.0;
  
  const avg = scores.reduce((a: number, b: number) => a + b, 0) / scores.length;
  return Math.round(avg * 2) / 2;
}
