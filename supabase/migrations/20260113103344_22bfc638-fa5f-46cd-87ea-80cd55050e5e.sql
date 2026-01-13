-- Create table for async speaking evaluation jobs
-- This enables real-time notifications and robust retry handling
CREATE TABLE IF NOT EXISTS public.speaking_evaluation_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  test_id UUID NOT NULL,
  preset_id UUID,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'completed', 'failed')),
  file_paths JSONB NOT NULL DEFAULT '{}',
  durations JSONB DEFAULT '{}',
  topic TEXT,
  difficulty TEXT,
  fluency_flag BOOLEAN DEFAULT false,
  retry_count INTEGER DEFAULT 0,
  max_retries INTEGER DEFAULT 5,
  last_error TEXT,
  result_id UUID, -- Reference to ai_practice_results once completed
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ
);

-- Index for efficient queries
CREATE INDEX idx_speaking_eval_jobs_user_status ON public.speaking_evaluation_jobs(user_id, status);
CREATE INDEX idx_speaking_eval_jobs_test ON public.speaking_evaluation_jobs(test_id);
CREATE INDEX idx_speaking_eval_jobs_pending ON public.speaking_evaluation_jobs(status) WHERE status IN ('pending', 'processing');

-- Enable RLS
ALTER TABLE public.speaking_evaluation_jobs ENABLE ROW LEVEL SECURITY;

-- Users can view their own jobs
CREATE POLICY "Users can view their own evaluation jobs"
ON public.speaking_evaluation_jobs FOR SELECT
USING (auth.uid() = user_id);

-- Users can insert their own jobs
CREATE POLICY "Users can create their own evaluation jobs"
ON public.speaking_evaluation_jobs FOR INSERT
WITH CHECK (auth.uid() = user_id);

-- Service role can update any job (for backend processing)
CREATE POLICY "Service role can update jobs"
ON public.speaking_evaluation_jobs FOR UPDATE
USING (true);

-- Enable Realtime for this table
ALTER PUBLICATION supabase_realtime ADD TABLE public.speaking_evaluation_jobs;

-- Trigger to update updated_at
CREATE TRIGGER update_speaking_evaluation_jobs_updated_at
BEFORE UPDATE ON public.speaking_evaluation_jobs
FOR EACH ROW
EXECUTE FUNCTION public.update_updated_at_column();