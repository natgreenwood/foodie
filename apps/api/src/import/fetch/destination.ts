import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";

// Where fetchPage may send a request. Called with every URL before it is
// requested, the first and each redirect hop, by every strategy. Resolves
// to why the URL is refused, or to the addresses it may be sent to; rejects
// only when the host cannot be resolved at all (SEC-1, CWE-918).
export type DestinationPolicy = (url: URL) => Promise<DestinationCheck>;

// `addresses` are the ones checked. The http strategy connects only to
// them, so the host is not resolved a second time (NATG-268).
export type DestinationCheck =
  { refused: string } | { refused: null; addresses: string[] };

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
  ["192.0.0.0", 24, "ipv4", "IETF protocol assignments"],
  ["192.168.0.0", 16, "ipv4", "private"],
  ["198.18.0.0", 15, "ipv4", "benchmarking"],
  ["224.0.0.0", 4, "ipv4", "multicast"],
  // Reserved, and 255.255.255.255 broadcast.
  ["240.0.0.0", 4, "ipv4", "reserved"],
  ["::", 128, "ipv6", "unspecified"],
  ["::1", 128, "ipv6", "loopback"],
  // Deprecated IPv4-compatible, such as ::127.0.0.1.
  ["::", 96, "ipv6", "IPv4-compatible"],
  // Refused whatever IPv4 address it carries, rather than unwrapped.
  ["::ffff:0:0", 96, "ipv6", "IPv4-mapped"],
  // Translators that turn the embedded IPv4 address back into a request to
  // it: NAT64 (an AWS NAT Gateway does this for IPv6-only subnets), 6to4
  // and Teredo. Refused outright, as IPv4-mapped is (NATG-270).
  ["64:ff9b::", 96, "ipv6", "NAT64"],
  ["64:ff9b:1::", 48, "ipv6", "NAT64 local-use"],
  ["2001::", 32, "ipv6", "Teredo"],
  ["2002::", 16, "ipv6", "6to4"],
  ["fc00::", 7, "ipv6", "unique-local"],
  ["fe80::", 10, "ipv6", "link-local"],
  ["fec0::", 10, "ipv6", "site-local"],
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
// The http strategy connects only to the addresses checked here. impit
// takes no resolver and resolves the host again itself, so a DNS server that
// answers differently the second time (rebinding) can still steer an impit
// request to a private address. That window is accepted (NATG-267); egress
// rules on the container close it.
export function publicOnly(resolve: Resolver = lookupAll): DestinationPolicy {
  return async (url) => {
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return { refused: `${url.protocol} is not http or https` };
    }
    if (url.username !== "" || url.password !== "") {
      return { refused: "URL carries credentials" };
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
        return {
          refused:
            address === host
              ? `${host} is ${range}`
              : `${host} resolves to ${address}, ${range}`,
        };
      }
    }
    return { refused: null, addresses };
  };
}

export const defaultDestinationPolicy = publicOnly();
