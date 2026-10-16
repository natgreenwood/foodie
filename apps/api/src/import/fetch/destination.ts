import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";

// Where fetchPage may send a request. Called with every URL before it is
// requested, the first and each redirect hop, by every strategy. Resolves
// to why the URL is refused, or null if it is allowed; rejects only when
// the host cannot be resolved at all (SEC-1, CWE-918).
export type DestinationPolicy = (url: URL) => Promise<string | null>;

// Every address a hostname resolves to. Rejects when it resolves to none.
export type Resolver = (hostname: string) => Promise<string[]>;

// Every A and AAAA record, as the strategies' own lookup would see them.
export const lookupAll: Resolver = async (hostname) => {
  const results = await lookup(hostname, { all: true, verbatim: true });
  return results.map((r) => r.address);
};

// Addresses that are not on the public internet: a request to one reaches
// the api's own host, its network, or the cloud metadata service.
const NON_PUBLIC: readonly [string, number, "ipv4" | "ipv6", string][] = [
  ["0.0.0.0", 8, "ipv4", "unspecified"],
  ["10.0.0.0", 8, "ipv4", "private"],
  ["100.64.0.0", 10, "ipv4", "CGNAT"],
  ["127.0.0.0", 8, "ipv4", "loopback"],
  ["169.254.0.0", 16, "ipv4", "link-local"],
  ["172.16.0.0", 12, "ipv4", "private"],
  ["192.168.0.0", 16, "ipv4", "private"],
  ["224.0.0.0", 4, "ipv4", "multicast"],
  // Reserved, and 255.255.255.255 broadcast.
  ["240.0.0.0", 4, "ipv4", "reserved"],
  ["::", 128, "ipv6", "unspecified"],
  ["::1", 128, "ipv6", "loopback"],
  // Refused whatever IPv4 address it carries, rather than unwrapped.
  ["::ffff:0:0", 96, "ipv6", "IPv4-mapped"],
  ["fc00::", 7, "ipv6", "unique-local"],
  ["fe80::", 10, "ipv6", "link-local"],
  ["ff00::", 8, "ipv6", "multicast"],
];

const ranges = NON_PUBLIC.map(([network, prefix, family, label]) => {
  const list = new BlockList();
  list.addSubnet(network, prefix, family);
  return { list, family, label: `${label} ${network}/${prefix}` };
});

// The range `address` falls in, such as "loopback 127.0.0.0/8", or null if
// it is public.
export function nonPublicRange(address: string): string | null {
  const family = isIP(address) === 6 ? "ipv6" : "ipv4";
  const hit = ranges.find(
    (r) => r.family === family && r.list.check(address, family),
  );
  return hit?.label ?? null;
}

// The default: http and https only, and only to a host whose every address
// is public. One private record is enough to refuse, since the strategy
// may connect to any of them.
//
// The strategies then resolve the host again themselves, so a DNS server
// that answers differently the second time (rebinding) can still steer a
// request to a private address. Pinning the checked address is not possible
// without a new dependency: impit takes no resolver, and Node's fetch takes
// one only through undici's Agent, which Node does not export. The window
// is accepted (NATG-267); egress rules on the container close it.
export function publicOnly(resolve: Resolver = lookupAll): DestinationPolicy {
  return async (url) => {
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return `${url.protocol} is not http or https`;
    }
    if (url.username !== "" || url.password !== "") {
      return "URL carries credentials";
    }
    // URL keeps the brackets on an IPv6 host; the address has none.
    const host = url.hostname.replace(/^\[(.*)\]$/, "$1");
    const addresses = isIP(host) ? [host] : await resolve(host);
    if (addresses.length === 0) {
      throw new Error(`${host} resolved to no address`);
    }
    for (const address of addresses) {
      const range = nonPublicRange(address);
      if (range) {
        return address === host
          ? `${host} is ${range}`
          : `${host} resolves to ${address}, ${range}`;
      }
    }
    return null;
  };
}

export const defaultDestinationPolicy = publicOnly();
