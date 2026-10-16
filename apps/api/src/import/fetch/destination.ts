import { lookup as dnsLookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";

// An address a host resolved to, in the shape node:dns returns it.
export interface Address {
  address: string;
  family: 4 | 6;
}

// Which destinations fetchPage may connect to (SEC-1, NATG-268). Injectable
// so the tests, whose fixture server is on loopback, can allow it.
export interface DestinationPolicy {
  // Every address the host resolves to.
  lookup(hostname: string): Promise<Address[]>;
  // Whether a connection to `address` is allowed.
  allows(address: string): boolean;
}

// Loopback, private, link-local, CGNAT, unspecified and multicast, in IPv4
// and IPv6, and the IPv4-mapped IPv6 form of each IPv4 range.
const IPV4_NON_PUBLIC: readonly [string, number][] = [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.168.0.0", 16],
  ["224.0.0.0", 4],
];
const IPV6_NON_PUBLIC: readonly [string, number][] = [
  ["::", 128],
  ["::1", 128],
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8],
];

const nonPublic = new BlockList();
for (const [net, prefix] of IPV4_NON_PUBLIC) {
  nonPublic.addSubnet(net, prefix, "ipv4");
  // Spelt out rather than left to BlockList, whose matching of mapped
  // addresses against IPv4 rules has varied between Node versions.
  nonPublic.addSubnet(`::ffff:${net}`, 96 + prefix, "ipv6");
}
for (const [net, prefix] of IPV6_NON_PUBLIC) {
  nonPublic.addSubnet(net, prefix, "ipv6");
}

// False for anything that is not an IP address at all.
export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 0) return false;
  return !nonPublic.check(address, family === 4 ? "ipv4" : "ipv6");
}

export const publicOnly: DestinationPolicy = {
  async lookup(hostname) {
    const addresses = await dnsLookup(hostname, { all: true });
    return addresses.map(({ address, family }) => ({
      address,
      family: family === 6 ? 6 : 4,
    }));
  },
  allows: isPublicAddress,
};

// The addresses to connect to for `url`, or null if the policy refuses its
// host. An IP literal is checked as it is and `localhost` without resolving;
// any other name is refused if any address it resolves to is refused, so a
// name cannot mix a public address with a private one. A DNS failure
// rejects, as a connection to the name would have.
export async function resolveDestination(
  url: URL,
  policy: DestinationPolicy,
): Promise<Address[] | null> {
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  // URL keeps the brackets around an IPv6 literal.
  const host = url.hostname.replace(/^\[(.*)\]$/, "$1");
  const name = host.replace(/\.$/, "");
  if (name === "localhost" || name.endsWith(".localhost")) return null;

  const literal = isIP(host);
  const addresses: Address[] =
    literal === 0
      ? await policy.lookup(host)
      : [{ address: host, family: literal === 6 ? 6 : 4 }];
  if (addresses.length === 0) return null;
  return addresses.every((a) => policy.allows(a.address)) ? addresses : null;
}
