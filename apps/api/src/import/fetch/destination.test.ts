import { describe, expect, it } from "vitest";
import {
  isPublicAddress,
  publicOnly,
  resolveDestination,
  type Address,
  type DestinationPolicy,
} from "./destination.js";

// publicOnly's rules with a fake DNS that answers every name with `answer`
// and records what it was asked.
function withDns(answer: Address[] | Error) {
  const asked: string[] = [];
  const policy: DestinationPolicy = {
    ...publicOnly,
    lookup(hostname) {
      asked.push(hostname);
      return answer instanceof Error
        ? Promise.reject(answer)
        : Promise.resolve(answer);
    },
  };
  return { policy, asked };
}

const v4 = (address: string): Address => ({ address, family: 4 });
const v6 = (address: string): Address => ({ address, family: 6 });

describe("resolveDestination", () => {
  it.each([
    // loopback
    "http://127.0.0.1/",
    "http://127.255.255.254/",
    "http://[::1]/",
    // private
    "http://10.1.2.3/",
    "http://172.16.0.1/",
    "http://172.31.255.255/",
    "http://192.168.0.1/",
    "http://[fc00::1]/",
    "http://[fd12:3456::1]/",
    // link-local, including the cloud metadata address
    "http://169.254.169.254/",
    "http://[fe80::1]/",
    // CGNAT
    "http://100.64.0.1/",
    "http://100.127.255.255/",
    // unspecified
    "http://0.0.0.0/",
    "http://[::]/",
    // multicast
    "http://224.0.0.1/",
    "http://239.255.255.250/",
    "http://[ff02::1]/",
    // IPv4-mapped IPv6
    "http://[::ffff:127.0.0.1]/",
    "http://[::ffff:10.0.0.1]/",
    "http://[::ffff:169.254.169.254]/",
    "http://[0:0:0:0:0:ffff:c0a8:1]/",
    // forms the URL parser normalises to 127.0.0.1 or 0.0.0.0
    "http://2130706433/",
    "http://0x7f000001/",
    "http://0177.0.0.1/",
    "http://127.1/",
    "http://0/",
    // names refused without resolving
    "http://localhost/",
    "http://LOCALHOST:8080/",
    "http://localhost./",
    "http://app.localhost/",
    // not http
    "ftp://example.com/",
  ])("refuses %s without a DNS lookup", async (raw) => {
    const { policy, asked } = withDns(new Error("must not resolve"));

    await expect(resolveDestination(new URL(raw), policy)).resolves.toBeNull();
    expect(asked).toEqual([]);
  });

  it.each([
    ["http://93.184.215.14/", v4("93.184.215.14")],
    ["https://172.32.0.1/", v4("172.32.0.1")],
    ["http://100.128.0.1/", v4("100.128.0.1")],
    ["http://[2606:4700::6810:84e5]/", v6("2606:4700::6810:84e5")],
    ["http://[::ffff:93.184.215.14]/", v6("::ffff:5db8:d70e")],
  ])("allows the public literal %s", async (raw, expected) => {
    const { policy, asked } = withDns(new Error("must not resolve"));

    await expect(resolveDestination(new URL(raw), policy)).resolves.toEqual([
      expected,
    ]);
    expect(asked).toEqual([]);
  });

  it("returns every address a public name resolves to", async () => {
    const answer = [v4("93.184.215.14"), v6("2606:4700::6810:84e5")];
    const { policy, asked } = withDns(answer);

    await expect(
      resolveDestination(new URL("https://recipes.example/pie"), policy),
    ).resolves.toEqual(answer);
    expect(asked).toEqual(["recipes.example"]);
  });

  it.each([
    ["a private address", [v4("10.0.0.5")]],
    ["loopback", [v6("::1")]],
    ["a public and a private address", [v4("93.184.215.14"), v4("10.0.0.5")]],
    ["no address", []],
  ])("refuses a name that resolves to %s", async (_, answer) => {
    const { policy } = withDns(answer);

    await expect(
      resolveDestination(new URL("https://recipes.example/pie"), policy),
    ).resolves.toBeNull();
  });

  it("rejects with the DNS error when the name does not resolve", async () => {
    const { policy } = withDns(new Error("getaddrinfo ENOTFOUND"));

    await expect(
      resolveDestination(new URL("https://nowhere.example/"), policy),
    ).rejects.toThrow("ENOTFOUND");
  });

  it("allows what an injected policy allows", async () => {
    const policy: DestinationPolicy = {
      ...publicOnly,
      allows: (address) => address === "127.0.0.1",
    };

    await expect(
      resolveDestination(new URL("http://127.0.0.1:3000/"), policy),
    ).resolves.toEqual([v4("127.0.0.1")]);
  });
});

describe("isPublicAddress", () => {
  it("is false for anything that is not an IP address", () => {
    expect(isPublicAddress("example.com")).toBe(false);
    expect(isPublicAddress("")).toBe(false);
  });
});
