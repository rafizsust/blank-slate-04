import { useEffect, useCallback, useState } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { useToast } from '@/hooks/use-toast';
import { useNavigate } from 'react-router-dom';

interface EvaluationJob {
  id: string;
  user_id: string;
  test_id: string;
  status: 'pending' | 'processing' | 'completed' | 'failed';
  result_id: string | null;
  last_error: string | null;
  retry_count: number;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

interface UseSpeakingEvaluationRealtimeOptions {
  testId: string;
  onComplete?: (resultId: string) => void;
  onFailed?: (error: string) => void;
  autoNavigate?: boolean;
}

export function useSpeakingEvaluationRealtime({
  testId,
  onComplete,
  onFailed,
  autoNavigate = false,
}: UseSpeakingEvaluationRealtimeOptions) {
  const { toast } = useToast();
  const navigate = useNavigate();
  const [jobStatus, setJobStatus] = useState<EvaluationJob['status'] | null>(null);
  const [isSubscribed, setIsSubscribed] = useState(false);

  const handleJobUpdate = useCallback((payload: { new: EvaluationJob }) => {
    const job = payload.new;
    console.log('[SpeakingEvaluationRealtime] Job update:', job.status, job.id);
    
    setJobStatus(job.status);

    if (job.status === 'completed' && job.result_id) {
      toast({
        title: 'Evaluation Complete!',
        description: 'Your speaking test results are ready.',
      });
      
      onComplete?.(job.result_id);
      
      if (autoNavigate) {
        navigate(`/ai-practice/speaking/results/${testId}`);
      }
    } else if (job.status === 'failed') {
      const errorMessage = job.last_error || 'Evaluation failed. Please try again.';
      toast({
        title: 'Evaluation Failed',
        description: errorMessage,
        variant: 'destructive',
      });
      
      onFailed?.(errorMessage);
    } else if (job.status === 'processing') {
      // Optionally show processing toast
      console.log('[SpeakingEvaluationRealtime] Job is processing...');
    }
  }, [testId, onComplete, onFailed, autoNavigate, navigate, toast]);

  useEffect(() => {
    if (!testId) return;

    console.log('[SpeakingEvaluationRealtime] Subscribing to job updates for test:', testId);

    // Subscribe to changes on speaking_evaluation_jobs for this test
    const channel = supabase
      .channel(`speaking-eval-${testId}`)
      .on(
        'postgres_changes',
        {
          event: 'UPDATE',
          schema: 'public',
          table: 'speaking_evaluation_jobs',
          filter: `test_id=eq.${testId}`,
        },
        handleJobUpdate
      )
      .subscribe((status) => {
        console.log('[SpeakingEvaluationRealtime] Subscription status:', status);
        setIsSubscribed(status === 'SUBSCRIBED');
      });

    return () => {
      console.log('[SpeakingEvaluationRealtime] Unsubscribing from job updates');
      supabase.removeChannel(channel);
      setIsSubscribed(false);
    };
  }, [testId, handleJobUpdate]);

  // Also check job status on mount (in case we missed the realtime event)
  useEffect(() => {
    if (!testId) return;

    const checkExistingJob = async () => {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) return;

      // Use type assertion since the table was just created
      const { data: jobs } = await supabase
        .from('speaking_evaluation_jobs' as any)
        .select('*')
        .eq('test_id', testId)
        .eq('user_id', user.id)
        .order('created_at', { ascending: false })
        .limit(1);

      if (jobs && jobs.length > 0) {
        const job = jobs[0] as unknown as EvaluationJob;
        setJobStatus(job.status);
        
        if (job.status === 'completed' && job.result_id) {
          onComplete?.(job.result_id);
          if (autoNavigate) {
            navigate(`/ai-practice/speaking/results/${testId}`);
          }
        }
      }
    };

    checkExistingJob();
  }, [testId, onComplete, autoNavigate, navigate]);

  return {
    jobStatus,
    isSubscribed,
    isPending: jobStatus === 'pending',
    isProcessing: jobStatus === 'processing',
    isCompleted: jobStatus === 'completed',
    isFailed: jobStatus === 'failed',
  };
}
