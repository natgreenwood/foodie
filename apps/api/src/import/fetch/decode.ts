import { TextDecoder } from "node:util";

// A body's text, decoded the way impit's native decodeBuffer() decodes it, so
// a page reads the same whichever strategy fetched it (NATG-261): the
// content-type header's charset if it names one TextDecoder knows, else the
// first known <meta> charset that ends in the first 1024 bytes, else UTF-8.
// A BOM is kept, not stripped, and bytes invalid in the chosen encoding
// become U+FFFD.
export function decodeBody(bytes: Uint8Array, contentType: string | null) {
  const decoder =
    decoderFor(
      /;\s*charset\s*=\s*"?([^";\s]*)/i.exec(contentType ?? "")?.[1],
    ) ??
    metaCharset(bytes) ??
    new TextDecoder("utf-8", { ignoreBOM: true });
  return decoder.decode(bytes);
}

// impit scans with an HTML tokenizer; this skips comments as it does, but
// not a <meta> inside a <script> or an attribute value, which it also skips.
function metaCharset(bytes: Uint8Array): TextDecoder | undefined {
  const head = Buffer.from(bytes.subarray(0, 1024))
    .toString("latin1")
    .replace(/<!--[\s\S]*?(?:-->|$)/g, "");
  for (const [tag] of head.matchAll(/<meta\b[^>]*>/gi)) {
    const decoder = decoderFor(
      /charset\s*=\s*["']?\s*([^\s"';>]+)/i.exec(tag)?.[1],
    );
    if (decoder) return decoder;
  }
  return undefined;
}

// undefined for a missing label or one TextDecoder does not support.
function decoderFor(label: string | undefined): TextDecoder | undefined {
  if (!label) return undefined;
  try {
    return new TextDecoder(label, { ignoreBOM: true });
  } catch {
    return undefined;
  }
}
