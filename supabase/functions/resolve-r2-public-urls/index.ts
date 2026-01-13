import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

interface ResolveRequest {
  filePaths: Record<string, string>;
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY")!;

    const supabase = createClient(supabaseUrl, supabaseAnonKey, {
      global: { headers: { Authorization: req.headers.get("Authorization")! } },
    });

    const { data: { user }, error: authError } = await supabase.auth.getUser();
    if (authError || !user) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const body: ResolveRequest = await req.json();
    const filePaths = body?.filePaths;

    if (!filePaths || typeof filePaths !== "object") {
      return new Response(JSON.stringify({ error: "filePaths is required" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const publicBase = (Deno.env.get("R2_PUBLIC_URL") || "").replace(/\/$/, "");
    if (!publicBase) {
      return new Response(JSON.stringify({ error: "R2 public URL not configured" }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Security: only allow paths within this user's speaking-audios folder
    const allowedPrefix = `speaking-audios/ai-speaking/${user.id}/`;

    const audioUrls: Record<string, string> = {};
    for (const [k, v] of Object.entries(filePaths)) {
      const r2Key = String(v || "").replace(/^\//, "");
      if (!r2Key.startsWith(allowedPrefix)) continue;
      audioUrls[k] = `${publicBase}/${r2Key}`;
    }

    return new Response(JSON.stringify({ success: true, audioUrls }), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error: unknown) {
    console.error("resolve-r2-public-urls error:", error);
    const message = error instanceof Error ? error.message : "Unknown error";
    return new Response(JSON.stringify({ error: message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
