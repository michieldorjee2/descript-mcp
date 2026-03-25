/**
 * Fake OAuth 2.1 endpoints for MCP clients that require OAuth.
 *
 * Flow:
 * 1. Client discovers auth server via /.well-known/oauth-protected-resource
 * 2. Client fetches /.well-known/oauth-authorization-server for endpoints
 * 3. Client dynamically registers via /oauth/register
 * 4. Client redirects user to /oauth/authorize (we immediately redirect back with a code)
 * 5. Client exchanges code at /oauth/token (we return DESCRIPT_API_TOKEN as access_token)
 *
 * The authorization code encodes the PKCE challenge so the token endpoint can
 * verify it without shared state (important for serverless).
 */

function getOrigin(req: Request): string {
  const forwarded = req.headers.get("x-forwarded-proto");
  const host = req.headers.get("x-forwarded-host") || req.headers.get("host");
  const proto = forwarded || "https";
  return `${proto}://${host}`;
}

function json(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": "no-store",
      ...headers,
    },
  });
}

function cors(): Response {
  return new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
      "Access-Control-Max-Age": "86400",
    },
  });
}

// --- Discovery Endpoints ---

export function handleProtectedResourceMetadata(req: Request): Response {
  if (req.method === "OPTIONS") return cors();
  const origin = getOrigin(req);
  return json({
    resource: origin,
    authorization_servers: [origin],
    bearer_methods_supported: ["header"],
    scopes_supported: ["descript"],
  });
}

export function handleAuthServerMetadata(req: Request): Response {
  if (req.method === "OPTIONS") return cors();
  const origin = getOrigin(req);
  return json({
    issuer: origin,
    authorization_endpoint: `${origin}/oauth/authorize`,
    token_endpoint: `${origin}/oauth/token`,
    registration_endpoint: `${origin}/oauth/register`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["client_secret_basic", "client_secret_post", "none"],
    scopes_supported: ["descript"],
    service_documentation: "https://docs.descriptapi.com/",
  });
}

// --- Dynamic Client Registration (RFC 7591) ---

export function handleRegister(req: Request): Response {
  if (req.method === "OPTIONS") return cors();
  // Accept any registration, return a client_id
  const clientId = `descript-mcp-client-${crypto.randomUUID().slice(0, 8)}`;
  return json(
    {
      client_id: clientId,
      client_name: "Descript MCP Client",
      redirect_uris: [],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    },
    201
  );
}

// --- Authorization Endpoint ---

export function handleAuthorize(req: Request): Response {
  if (req.method === "OPTIONS") return cors();

  const url = new URL(req.url);
  const redirectUri = url.searchParams.get("redirect_uri");
  const state = url.searchParams.get("state");
  const codeChallenge = url.searchParams.get("code_challenge");
  const clientId = url.searchParams.get("client_id");

  if (!redirectUri) {
    return json({ error: "invalid_request", error_description: "redirect_uri is required" }, 400);
  }

  // Encode PKCE challenge into the authorization code so the token endpoint
  // can verify it statelessly (serverless-friendly).
  const codePayload = JSON.stringify({
    cc: codeChallenge,
    cid: clientId,
    ru: redirectUri,
    ts: Date.now(),
  });
  const code = btoa(codePayload).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

  const redirect = new URL(redirectUri);
  redirect.searchParams.set("code", code);
  if (state) redirect.searchParams.set("state", state);

  return new Response(null, {
    status: 302,
    headers: {
      Location: redirect.toString(),
      "Cache-Control": "no-store",
    },
  });
}

// --- Token Endpoint ---

export async function handleToken(req: Request): Promise<Response> {
  if (req.method === "OPTIONS") return cors();

  const body = await req.formData().catch(() => null);
  if (!body) {
    return json({ error: "invalid_request", error_description: "Expected form data" }, 400);
  }

  const grantType = body.get("grant_type") as string;

  if (grantType === "authorization_code") {
    const code = body.get("code") as string;
    const codeVerifier = body.get("code_verifier") as string;

    if (!code) {
      return json({ error: "invalid_request", error_description: "code is required" }, 400);
    }

    // Decode the authorization code
    let payload: { cc: string; cid: string; ru: string; ts: number };
    try {
      const padded = code.replace(/-/g, "+").replace(/_/g, "/");
      payload = JSON.parse(atob(padded));
    } catch {
      return json({ error: "invalid_grant", error_description: "Invalid authorization code" }, 400);
    }

    // Verify PKCE if a challenge was provided during authorization
    if (payload.cc && codeVerifier) {
      const encoder = new TextEncoder();
      const digest = await crypto.subtle.digest("SHA-256", encoder.encode(codeVerifier));
      const computed = btoa(String.fromCharCode(...new Uint8Array(digest)))
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=+$/, "");

      if (computed !== payload.cc) {
        return json({ error: "invalid_grant", error_description: "PKCE verification failed" }, 400);
      }
    }

    // Check code expiry (5 minutes)
    if (Date.now() - payload.ts > 5 * 60 * 1000) {
      return json({ error: "invalid_grant", error_description: "Authorization code expired" }, 400);
    }

    // Return the Descript API token from env as the access_token
    const accessToken = process.env.DESCRIPT_API_TOKEN;
    if (!accessToken) {
      return json(
        { error: "server_error", error_description: "DESCRIPT_API_TOKEN environment variable not set" },
        500
      );
    }

    return json({
      access_token: accessToken,
      token_type: "Bearer",
      expires_in: 86400,
      scope: "descript",
    });
  }

  if (grantType === "refresh_token") {
    const accessToken = process.env.DESCRIPT_API_TOKEN;
    if (!accessToken) {
      return json(
        { error: "server_error", error_description: "DESCRIPT_API_TOKEN environment variable not set" },
        500
      );
    }
    return json({
      access_token: accessToken,
      token_type: "Bearer",
      expires_in: 86400,
      scope: "descript",
    });
  }

  return json({ error: "unsupported_grant_type" }, 400);
}
