import { normalizeIP } from "@fastify/rate-limit";
import type { FastifyRequest } from "fastify";

// The client a per-client limit counts against: request.ip, which follows
// TRUST_PROXY, with an IPv6 address grouped to its /64 and an IPv4-mapped
// address as plain IPv4. A client usually holds a whole /64, so counting
// full IPv6 addresses would let it reset its budget by changing address.
// Both OIDC limiters and the rate-limited log line use this, so they agree.
export function clientKey(request: FastifyRequest): string {
  return normalizeIP(request.ip);
}
