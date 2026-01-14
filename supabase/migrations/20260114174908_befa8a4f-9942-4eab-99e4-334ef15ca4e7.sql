-- Add per-model quota tracking columns for each Gemini model used across the application
-- This enables granular tracking of quota exhaustion per specific model per API key

-- Models used in the application:
-- gemini-2.0-flash, gemini-2.0-flash-lite-preview-02-05, gemini-2.0-flash-lite
-- gemini-2.5-flash, gemini-2.5-flash-preview-tts
-- gemini-2.5-pro, gemini-3-pro-preview, gemini-exp-1206

-- Add columns for gemini-2.0-flash
ALTER TABLE public.api_keys ADD COLUMN IF NOT EXISTS gemini_2_0_flash_exhausted boolean DEFAULT false;
ALTER TABLE public.api_keys ADD COLUMN IF NOT EXISTS gemini_2_0_flash_exhausted_date date;

-- Add columns for gemini-2.0-flash-lite (including preview)
ALTER TABLE public.api_keys ADD COLUMN IF NOT EXISTS gemini_2_0_flash_lite_exhausted boolean DEFAULT false;
ALTER TABLE public.api_keys ADD COLUMN IF NOT EXISTS gemini_2_0_flash_lite_exhausted_date date;

-- Add columns for gemini-2.5-flash
ALTER TABLE public.api_keys ADD COLUMN IF NOT EXISTS gemini_2_5_flash_exhausted boolean DEFAULT false;
ALTER TABLE public.api_keys ADD COLUMN IF NOT EXISTS gemini_2_5_flash_exhausted_date date;

-- Add columns for gemini-2.5-flash-preview-tts
ALTER TABLE public.api_keys ADD COLUMN IF NOT EXISTS gemini_2_5_flash_tts_exhausted boolean DEFAULT false;
ALTER TABLE public.api_keys ADD COLUMN IF NOT EXISTS gemini_2_5_flash_tts_exhausted_date date;

-- Add columns for gemini-2.5-pro
ALTER TABLE public.api_keys ADD COLUMN IF NOT EXISTS gemini_2_5_pro_exhausted boolean DEFAULT false;
ALTER TABLE public.api_keys ADD COLUMN IF NOT EXISTS gemini_2_5_pro_exhausted_date date;

-- Add columns for gemini-3-pro-preview
ALTER TABLE public.api_keys ADD COLUMN IF NOT EXISTS gemini_3_pro_exhausted boolean DEFAULT false;
ALTER TABLE public.api_keys ADD COLUMN IF NOT EXISTS gemini_3_pro_exhausted_date date;

-- Add columns for gemini-exp-1206
ALTER TABLE public.api_keys ADD COLUMN IF NOT EXISTS gemini_exp_1206_exhausted boolean DEFAULT false;
ALTER TABLE public.api_keys ADD COLUMN IF NOT EXISTS gemini_exp_1206_exhausted_date date;

-- Create a function to reset all model quotas for a specific key
CREATE OR REPLACE FUNCTION public.reset_api_key_model_quotas(p_key_id uuid DEFAULT NULL)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF p_key_id IS NULL THEN
    -- Reset all keys where any quota was exhausted before today
    UPDATE public.api_keys
    SET 
      -- Legacy bucket quotas
      tts_quota_exhausted = false,
      tts_quota_exhausted_date = NULL,
      flash_2_5_quota_exhausted = false,
      flash_2_5_quota_exhausted_date = NULL,
      flash_lite_quota_exhausted = false,
      flash_lite_quota_exhausted_date = NULL,
      pro_3_0_quota_exhausted = false,
      pro_3_0_quota_exhausted_date = NULL,
      exp_pro_quota_exhausted = false,
      exp_pro_quota_exhausted_date = NULL,
      -- New per-model quotas
      gemini_2_0_flash_exhausted = false,
      gemini_2_0_flash_exhausted_date = NULL,
      gemini_2_0_flash_lite_exhausted = false,
      gemini_2_0_flash_lite_exhausted_date = NULL,
      gemini_2_5_flash_exhausted = false,
      gemini_2_5_flash_exhausted_date = NULL,
      gemini_2_5_flash_tts_exhausted = false,
      gemini_2_5_flash_tts_exhausted_date = NULL,
      gemini_2_5_pro_exhausted = false,
      gemini_2_5_pro_exhausted_date = NULL,
      gemini_3_pro_exhausted = false,
      gemini_3_pro_exhausted_date = NULL,
      gemini_exp_1206_exhausted = false,
      gemini_exp_1206_exhausted_date = NULL,
      updated_at = now()
    WHERE 
      is_active = true AND (
        -- Check legacy quotas
        (tts_quota_exhausted = true AND tts_quota_exhausted_date < CURRENT_DATE) OR
        (flash_2_5_quota_exhausted = true AND flash_2_5_quota_exhausted_date < CURRENT_DATE) OR
        (flash_lite_quota_exhausted = true AND flash_lite_quota_exhausted_date < CURRENT_DATE) OR
        (pro_3_0_quota_exhausted = true AND pro_3_0_quota_exhausted_date < CURRENT_DATE) OR
        (exp_pro_quota_exhausted = true AND exp_pro_quota_exhausted_date < CURRENT_DATE) OR
        -- Check new model quotas
        (gemini_2_0_flash_exhausted = true AND gemini_2_0_flash_exhausted_date < CURRENT_DATE) OR
        (gemini_2_0_flash_lite_exhausted = true AND gemini_2_0_flash_lite_exhausted_date < CURRENT_DATE) OR
        (gemini_2_5_flash_exhausted = true AND gemini_2_5_flash_exhausted_date < CURRENT_DATE) OR
        (gemini_2_5_flash_tts_exhausted = true AND gemini_2_5_flash_tts_exhausted_date < CURRENT_DATE) OR
        (gemini_2_5_pro_exhausted = true AND gemini_2_5_pro_exhausted_date < CURRENT_DATE) OR
        (gemini_3_pro_exhausted = true AND gemini_3_pro_exhausted_date < CURRENT_DATE) OR
        (gemini_exp_1206_exhausted = true AND gemini_exp_1206_exhausted_date < CURRENT_DATE)
      );
  ELSE
    -- Reset specific key
    UPDATE public.api_keys
    SET 
      -- Legacy bucket quotas
      tts_quota_exhausted = false,
      tts_quota_exhausted_date = NULL,
      flash_2_5_quota_exhausted = false,
      flash_2_5_quota_exhausted_date = NULL,
      flash_lite_quota_exhausted = false,
      flash_lite_quota_exhausted_date = NULL,
      pro_3_0_quota_exhausted = false,
      pro_3_0_quota_exhausted_date = NULL,
      exp_pro_quota_exhausted = false,
      exp_pro_quota_exhausted_date = NULL,
      -- New per-model quotas
      gemini_2_0_flash_exhausted = false,
      gemini_2_0_flash_exhausted_date = NULL,
      gemini_2_0_flash_lite_exhausted = false,
      gemini_2_0_flash_lite_exhausted_date = NULL,
      gemini_2_5_flash_exhausted = false,
      gemini_2_5_flash_exhausted_date = NULL,
      gemini_2_5_flash_tts_exhausted = false,
      gemini_2_5_flash_tts_exhausted_date = NULL,
      gemini_2_5_pro_exhausted = false,
      gemini_2_5_pro_exhausted_date = NULL,
      gemini_3_pro_exhausted = false,
      gemini_3_pro_exhausted_date = NULL,
      gemini_exp_1206_exhausted = false,
      gemini_exp_1206_exhausted_date = NULL,
      updated_at = now()
    WHERE id = p_key_id;
  END IF;
END;
$$;

-- Update the existing reset_api_key_quotas function to use the new one
CREATE OR REPLACE FUNCTION public.reset_api_key_quotas()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  PERFORM public.reset_api_key_model_quotas(NULL);
END;
$$;