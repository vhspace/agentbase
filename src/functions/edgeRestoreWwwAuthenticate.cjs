// Lambda@Edge origin-response handler for the mcp.agentbase.tools distribution.
//
// Lambda function URLs rename WWW-Authenticate to x-amzn-Remapped-WWW-Authenticate
// before the response leaves the function, and CloudFront Functions can't fix it
// because they don't run on origin responses with status 400 and above. This
// copies the header back so MCP clients that only read WWW-Authenticate on a 401
// can find the authorization server.
//
// Lambda@Edge: no environment variables, no bundling, plain CommonJS.
"use strict";

const REMAPPED = "x-amzn-remapped-www-authenticate";
const ORIGINAL = "www-authenticate";

exports.handler = async (event) => {
  const response = event.Records[0].cf.response;
  const headers = response.headers;
  const remapped = headers[REMAPPED];
  if (remapped && remapped.length > 0 && !headers[ORIGINAL]) {
    headers[ORIGINAL] = remapped.map((h) => ({ key: "WWW-Authenticate", value: h.value }));
    delete headers[REMAPPED];
  }
  return response;
};
