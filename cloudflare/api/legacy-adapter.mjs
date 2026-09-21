function requestQuery(url) {
  const result = {};

  for (const [key, value] of url.searchParams) {
    if (result[key] === undefined) {
      result[key] = value;
    } else if (Array.isArray(result[key])) {
      result[key].push(value);
    } else {
      result[key] = [result[key], value];
    }
  }

  return result;
}

async function requestBody(request) {
  if (
    request.method === "GET" ||
    request.method === "HEAD"
  ) {
    return undefined;
  }

  const text = await request.text();

  if (!text) {
    return undefined;
  }

  const contentType =
    request.headers.get("content-type") || "";

  if (contentType.includes("application/json")) {
    return JSON.parse(text);
  }

  return text;
}

export async function runLegacyHandler(
  request,
  handler
) {
  const url = new URL(request.url);
  const headers = new Headers();

  let statusCode = 200;
  let responseBody = null;

  const res = {
    setHeader(name, value) {
      headers.delete(name);

      if (Array.isArray(value)) {
        for (const item of value) {
          headers.append(name, String(item));
        }
      } else {
        headers.set(name, String(value));
      }

      return this;
    },

    getHeader(name) {
      return headers.get(name);
    },

    status(code) {
      statusCode = code;
      return this;
    },

    json(data) {
      headers.set(
        "Content-Type",
        "application/json; charset=utf-8"
      );

      responseBody = JSON.stringify(data);

      return this;
    },

    end(data) {
      if (data !== undefined) {
        responseBody = String(data);
      }

      return this;
    }
  };

  Object.defineProperty(res, "statusCode", {
    get() {
      return statusCode;
    },

    set(value) {
      statusCode = value;
    }
  });

  let body;

  try {
    body = await requestBody(request);
  } catch {
    return new Response(
      JSON.stringify({
        error: "INVALID_REQUEST_BODY"
      }),
      {
        status: 400,
        headers: {
          "Content-Type": "application/json"
        }
      }
    );
  }

  const req = {
    method: request.method,
    headers: Object.fromEntries(
      request.headers.entries()
    ),
    query: requestQuery(url),
    body,
    url: url.pathname + url.search
  };

  try {
    await handler(req, res);

    return new Response(
      request.method === "HEAD"
        ? null
        : responseBody,
      {
        status: statusCode,
        headers
      }
    );
  } catch (error) {
    console.error(
      "APXN API handler failed:",
      error?.message || "Unknown error"
    );

    return new Response(
      JSON.stringify({
        error: "INTERNAL_SERVER_ERROR"
      }),
      {
        status: 500,
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": "no-store"
        }
      }
    );
  }
}
