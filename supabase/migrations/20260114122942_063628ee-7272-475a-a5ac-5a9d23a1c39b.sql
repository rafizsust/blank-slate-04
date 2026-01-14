-- Add progress tracking to speaking evaluation jobs
ALTER TABLE public.speaking_evaluation_jobs
ADD COLUMN IF NOT EXISTS progress INTEGER DEFAULT 0,
ADD COLUMN IF NOT EXISTS partial_results JSONB DEFAULT '{}',
ADD COLUMN IF NOT EXISTS current_part INTEGER DEFAULT 0,
ADD COLUMN IF NOT EXISTS total_parts INTEGER DEFAULT 3;

COMMENT ON COLUMN public.speaking_evaluation_jobs.progress IS 'Evaluation progress percentage (0-100)';
COMMENT ON COLUMN public.speaking_evaluation_jobs.partial_results IS 'Intermediate results from each part evaluation';
COMMENT ON COLUMN public.speaking_evaluation_jobs.current_part IS 'Current part being evaluated (1, 2, or 3)';
COMMENT ON COLUMN public.speaking_evaluation_jobs.total_parts IS 'Total parts to evaluate';