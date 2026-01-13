-- Drop the overly permissive policy and create a more secure one
DROP POLICY IF EXISTS "Service role can update jobs" ON public.speaking_evaluation_jobs;

-- Service role updates are handled via supabase service key which bypasses RLS
-- We don't need an explicit policy for it since service key has full access
-- Instead, we add a policy for users to check their pending jobs (for polling fallback)
CREATE POLICY "Users can check their pending jobs"
ON public.speaking_evaluation_jobs FOR UPDATE
USING (auth.uid() = user_id AND status IN ('pending', 'failed'))
WITH CHECK (auth.uid() = user_id AND status IN ('pending', 'failed'));