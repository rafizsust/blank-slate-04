import { useState, useEffect, useCallback, useRef } from 'react';
import { supabase } from '@/integrations/supabase/client';

export type JobStatus = 'pending' | 'processing' | 'completed' | 'failed';

interface JobPollingOptions<T> {
  /** Table name to poll from */
  tableName: string;
  /** Column name that contains the job ID */
  idColumn?: string;
  /** The job ID to monitor */
  jobId: string | null;
  /** Polling interval in milliseconds */
  pollInterval?: number;
  /** Whether to use Supabase Realtime as primary (with polling fallback) */
  useRealtime?: boolean;
  /** Callback when job completes */
  onComplete?: (job: T) => void;
  /** Callback when job fails */
  onFailed?: (job: T) => void;
  /** Callback when job is detected as stale (stuck processing too long) */
  onStale?: (job: T) => void;
  /** Callback on any status change */
  onStatusChange?: (status: JobStatus, job: T) => void;
  /** Whether polling is enabled */
  enabled?: boolean;
  /** Stale job timeout in milliseconds (default: 5 minutes) */
  staleTimeoutMs?: number;
}

interface JobPollingResult<T> {
  job: T | null;
  status: JobStatus | null;
  isLoading: boolean;
  error: string | null;
  isSubscribed: boolean;
  isStale: boolean;
  refetch: () => Promise<void>;
}

// Default stale timeout: 5 minutes
const DEFAULT_STALE_TIMEOUT_MS = 5 * 60 * 1000;

export function useJobPolling<T extends { status: string; id: string; updated_at?: string; created_at?: string }>({
  tableName,
  idColumn = 'id',
  jobId,
  pollInterval = 5000,
  useRealtime = true,
  onComplete,
  onFailed,
  onStale,
  onStatusChange,
  enabled = true,
  staleTimeoutMs = DEFAULT_STALE_TIMEOUT_MS,
}: JobPollingOptions<T>): JobPollingResult<T> {
  const [job, setJob] = useState<T | null>(null);
  const [status, setStatus] = useState<JobStatus | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isSubscribed, setIsSubscribed] = useState(false);
  const [isStale, setIsStale] = useState(false);

  const pollTimerRef = useRef<number | null>(null);
  const hasCompletedRef = useRef(false);
  const hasReportedStaleRef = useRef(false);
  const lastStatusRef = useRef<JobStatus | null>(null);

  // Keep callbacks stable
  const onCompleteRef = useRef(onComplete);
  const onFailedRef = useRef(onFailed);
  const onStaleRef = useRef(onStale);
  const onStatusChangeRef = useRef(onStatusChange);

  useEffect(() => { onCompleteRef.current = onComplete; }, [onComplete]);
  useEffect(() => { onFailedRef.current = onFailed; }, [onFailed]);
  useEffect(() => { onStaleRef.current = onStale; }, [onStale]);
  useEffect(() => { onStatusChangeRef.current = onStatusChange; }, [onStatusChange]);

  /**
   * Check if a job is stale (stuck in pending/processing for too long)
   */
  const checkIfStale = useCallback((jobData: T): boolean => {
    const jobStatus = jobData.status as JobStatus;
    
    // Only check stale for pending/processing jobs
    if (jobStatus === 'completed' || jobStatus === 'failed') {
      return false;
    }

    // Use updated_at if available, otherwise created_at
    const timestampField = jobData.updated_at || jobData.created_at;
    if (!timestampField) {
      return false;
    }

    const jobTimestamp = new Date(timestampField).getTime();
    const now = Date.now();
    const elapsedMs = now - jobTimestamp;

    return elapsedMs > staleTimeoutMs;
  }, [staleTimeoutMs]);

  const handleJobUpdate = useCallback((jobData: T) => {
    const jobStatus = jobData.status as JobStatus;
    
    setJob(jobData);
    setStatus(jobStatus);
    setIsLoading(false);

    // Check for stale job
    const staleDetected = checkIfStale(jobData);
    if (staleDetected && !hasReportedStaleRef.current) {
      hasReportedStaleRef.current = true;
      setIsStale(true);
      console.warn(`[useJobPolling] Job ${jobData.id} detected as stale (processing for over ${staleTimeoutMs / 1000}s)`);
      onStaleRef.current?.(jobData);
    }

    // Notify on status change
    if (lastStatusRef.current !== jobStatus) {
      lastStatusRef.current = jobStatus;
      onStatusChangeRef.current?.(jobStatus, jobData);
    }

    // Handle completion
    if (jobStatus === 'completed' && !hasCompletedRef.current) {
      hasCompletedRef.current = true;
      setIsStale(false);
      onCompleteRef.current?.(jobData);
    }

    // Handle failure
    if (jobStatus === 'failed') {
      setIsStale(false);
      onFailedRef.current?.(jobData);
    }
  }, [checkIfStale, staleTimeoutMs]);

  const fetchJob = useCallback(async () => {
    if (!jobId || !enabled) return;

    try {
      // Use type assertion for dynamic table queries
      const { data, error: fetchError } = await (supabase
        .from(tableName as 'speaking_evaluation_jobs')
        .select('*')
        .eq(idColumn as 'id', jobId)
        .single());

      if (fetchError) {
        setError(fetchError.message);
        setIsLoading(false);
        return;
      }

      if (data) {
        handleJobUpdate(data as unknown as T);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch job status');
      setIsLoading(false);
    }
  }, [jobId, tableName, idColumn, enabled, handleJobUpdate]);

  // Realtime subscription
  useEffect(() => {
    if (!jobId || !enabled || !useRealtime) return;

    const channel = supabase
      .channel(`job-${tableName}-${jobId}`)
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: tableName,
          filter: `${idColumn}=eq.${jobId}`,
        },
        (payload: any) => {
          if (payload?.new) {
            handleJobUpdate(payload.new as T);
          }
        }
      )
      .subscribe((subscriptionStatus) => {
        setIsSubscribed(subscriptionStatus === 'SUBSCRIBED');
      });

    return () => {
      supabase.removeChannel(channel);
      setIsSubscribed(false);
    };
  }, [jobId, tableName, idColumn, enabled, useRealtime, handleJobUpdate]);

  // Polling fallback
  useEffect(() => {
    if (!jobId || !enabled) return;

    // Initial fetch
    fetchJob();

    // Set up polling
    const shouldPoll = status !== 'completed' && status !== 'failed';
    
    if (shouldPoll) {
      pollTimerRef.current = window.setInterval(fetchJob, pollInterval);
    }

    return () => {
      if (pollTimerRef.current) {
        clearInterval(pollTimerRef.current);
        pollTimerRef.current = null;
      }
    };
  }, [jobId, enabled, pollInterval, status, fetchJob]);

  // Reset state when jobId changes
  useEffect(() => {
    if (jobId) {
      hasCompletedRef.current = false;
      hasReportedStaleRef.current = false;
      lastStatusRef.current = null;
      setIsLoading(true);
      setError(null);
      setIsStale(false);
    }
  }, [jobId]);

  return {
    job,
    status,
    isLoading,
    error,
    isSubscribed,
    isStale,
    refetch: fetchJob,
  };
}
