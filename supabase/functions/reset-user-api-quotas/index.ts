import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

/**
 * Daily User API Key Quota Reset
 * 
 * This edge function is designed to be called by a Supabase scheduled job (cron)
 * to reset all user API key quotas at midnight UTC.
 * 
 * Schedule: 0 0 * * * (every day at 00:00 UTC)
 * 
 * It resets both:
 * - tts_quota_exhausted (for TTS/audio generation)
 * - flash_quota_exhausted (for Flash model text generation)
 * 
 * For user_api_keys table.
 */

serve(async (req) => {
  // Handle CORS preflight
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    // Create service client for admin operations
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

    if (!supabaseUrl || !supabaseServiceKey) {
      throw new Error("Missing Supabase configuration");
    }

    const serviceClient = createClient(supabaseUrl, supabaseServiceKey);

    console.log("Starting daily user API key quota reset...");

    // Get today's date
    const today = new Date().toISOString().split("T")[0];

    // Reset user API keys where quota was exhausted on a previous day
    const { data: userKeysReset, error: userKeysError } = await serviceClient
      .from("user_api_keys")
      .update({
        tts_quota_exhausted: false,
        tts_quota_exhausted_date: null,
        flash_2_5_quota_exhausted: false,
        flash_2_5_quota_exhausted_date: null,
        updated_at: new Date().toISOString(),
      })
      .or(`tts_quota_exhausted_date.lt.${today},flash_2_5_quota_exhausted_date.lt.${today}`)
      .select("id");

    if (userKeysError) {
      console.error("Error resetting user API keys:", userKeysError);
      throw userKeysError;
    }

    const userKeysCount = userKeysReset?.length || 0;
    console.log(`Reset ${userKeysCount} user API key quotas`);

    // Reset admin API keys using the database function
    const { error: adminKeysError } = await serviceClient.rpc('reset_api_key_model_quotas');

    if (adminKeysError) {
      console.error("Error resetting admin API keys:", adminKeysError);
      throw adminKeysError;
    }

    console.log("Reset admin API key quotas via reset_api_key_model_quotas()");

    // Reset user daily credits (profiles.daily_credits_used)
    const { data: profilesReset, error: profilesError } = await serviceClient
      .from("profiles")
      .update({
        daily_credits_used: 0,
        last_reset_date: today,
        updated_at: new Date().toISOString(),
      })
      .lt("last_reset_date", today)
      .select("id");

    if (profilesError) {
      console.error("Error resetting user profiles:", profilesError);
      throw profilesError;
    }

    const profilesCount = profilesReset?.length || 0;
    console.log(`Reset ${profilesCount} user profile credits`);

    const result = {
      success: true,
      message: "Daily quota reset completed",
      timestamp: new Date().toISOString(),
      stats: {
        userApiKeysReset: userKeysCount,
        adminApiKeysReset: "all (via RPC)",
        userProfilesReset: profilesCount,
      },
    };

    console.log("Daily quota reset completed:", result);

    return new Response(JSON.stringify(result), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error: unknown) {
    console.error("Daily quota reset error:", error);
    const message = error instanceof Error ? error.message : "Unknown error";

    return new Response(
      JSON.stringify({
        success: false,
        error: message,
        timestamp: new Date().toISOString(),
      }),
      {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  }
});
