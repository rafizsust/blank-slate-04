import lamejs from '@breezystack/lamejs';

/**
 * Compress audio file to MP3 using lamejs (pure JavaScript, no WASM/cross-origin requirements)
 * Optimized for spoken word/IELTS content: Mono, 22kHz, 32kbps
 * 
 * @param file - The audio file to compress
 * @param onProgress - Optional progress callback (0-100)
 * @returns Compressed audio file as MP3
 */
export async function compressAudio(
  file: File,
  onProgress?: (progress: number) => void
): Promise<File> {
  try {
    // Decode audio file to PCM samples
    const arrayBuffer = await file.arrayBuffer();
    const audioContext = new AudioContext();
    const audioBuffer = await audioContext.decodeAudioData(arrayBuffer);
    
    // Get audio data (convert to mono if stereo)
    const numberOfChannels = audioBuffer.numberOfChannels;
    let samples: Float32Array;
    
    if (numberOfChannels === 1) {
      samples = audioBuffer.getChannelData(0);
    } else {
      // Mix down to mono
      const left = audioBuffer.getChannelData(0);
      const right = audioBuffer.getChannelData(1);
      samples = new Float32Array(left.length);
      for (let i = 0; i < left.length; i++) {
        samples[i] = (left[i] + right[i]) / 2;
      }
    }
    
    // Resample to 22kHz for aggressive compression (optimal for speech recognition)
    // Lower sample rate = smaller file size while maintaining intelligibility
    const originalSampleRate = audioBuffer.sampleRate;
    const targetSampleRate = 22050; // 22kHz is sufficient for speech
    const resampledSamples = resampleAudio(samples, originalSampleRate, targetSampleRate);
    
    // Convert float samples to 16-bit PCM
    const pcmSamples = new Int16Array(resampledSamples.length);
    for (let i = 0; i < resampledSamples.length; i++) {
      const s = Math.max(-1, Math.min(1, resampledSamples[i]));
      pcmSamples[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
    }
    
    // Encode to MP3 using lamejs
    // Use 32kbps mono @ 22kHz for maximum compression while maintaining speech clarity
    // This achieves ~85-90% size reduction compared to raw WebM
    const mp3encoder = new lamejs.Mp3Encoder(1, targetSampleRate, 32);
    const mp3Data: Uint8Array[] = [];
    
    const sampleBlockSize = 1152; // Must be multiple of 576 for MP3
    const totalBlocks = Math.ceil(pcmSamples.length / sampleBlockSize);
    
    for (let i = 0; i < pcmSamples.length; i += sampleBlockSize) {
      const sampleChunk = pcmSamples.subarray(i, i + sampleBlockSize);
      const mp3buf = mp3encoder.encodeBuffer(sampleChunk);
      if (mp3buf.length > 0) {
        mp3Data.push(new Uint8Array(mp3buf));
      }
      
      // Report progress
      if (onProgress) {
        const currentBlock = Math.floor(i / sampleBlockSize);
        onProgress(Math.round((currentBlock / totalBlocks) * 100));
      }
    }
    
    // Flush remaining data
    const mp3buf = mp3encoder.flush();
    if (mp3buf.length > 0) {
      mp3Data.push(new Uint8Array(mp3buf));
    }
    
    // Combine all MP3 chunks
    const totalLength = mp3Data.reduce((acc, chunk) => acc + chunk.length, 0);
    const mp3Array = new Uint8Array(totalLength);
    let offset = 0;
    for (const chunk of mp3Data) {
      mp3Array.set(chunk, offset);
      offset += chunk.length;
    }
    
    // Create new file with .mp3 extension
    const baseName = file.name.replace(/\.[^/.]+$/, '');
    
    if (onProgress) {
      onProgress(100);
    }
    
    await audioContext.close();
    
    return new File([mp3Array], `${baseName}.mp3`, { type: 'audio/mpeg' });
  } catch (error) {
    console.error('[AudioCompressor] Compression failed:', error);
    throw new Error(`Failed to compress audio: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}

/**
 * Simple linear interpolation resampling
 */
function resampleAudio(samples: Float32Array, fromRate: number, toRate: number): Float32Array {
  if (fromRate === toRate) {
    return samples;
  }
  
  const ratio = fromRate / toRate;
  const newLength = Math.round(samples.length / ratio);
  const result = new Float32Array(newLength);
  
  for (let i = 0; i < newLength; i++) {
    const srcIndex = i * ratio;
    const srcIndexFloor = Math.floor(srcIndex);
    const srcIndexCeil = Math.min(srcIndexFloor + 1, samples.length - 1);
    const fraction = srcIndex - srcIndexFloor;
    
    result[i] = samples[srcIndexFloor] * (1 - fraction) + samples[srcIndexCeil] * fraction;
  }
  
  return result;
}

/**
 * Check if audio compression is supported (always true with lamejs - pure JS)
 */
export function isCompressionSupported(): boolean {
  // lamejs is pure JavaScript, works everywhere
  return typeof AudioContext !== 'undefined' || typeof (window as any).webkitAudioContext !== 'undefined';
}

/**
 * Get approximate compression ratio estimate
 * @param originalSize - Original file size in bytes
 * @returns Estimated compressed size in bytes
 */
export function estimateCompressedSize(originalSize: number): number {
  // 32kbps mono MP3 is typically ~85-92% smaller than uncompressed audio (depends on original codec)
  // Conservative estimate: 12% of original size
  return Math.round(originalSize * 0.12);
}

/**
 * Format file size for display
 */
export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
