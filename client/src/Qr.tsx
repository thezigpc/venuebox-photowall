import { useEffect, useState } from "react";
import QRCode from "qrcode";

/** A QR code drawn locally (no network) as SVG, black on white for any camera. */
export function Qr({ url, className }: { url: string; className?: string }) {
  const [svg, setSvg] = useState("");
  useEffect(() => {
    let live = true;
    QRCode.toString(url, { type: "svg", margin: 1, errorCorrectionLevel: "M", color: { dark: "#000000", light: "#ffffff" } })
      .then((s) => live && setSvg(s))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [url]);
  if (!svg) return null;
  // The SVG is generated locally by the qrcode library from our own URL.
  return <div className={className} dangerouslySetInnerHTML={{ __html: svg }} />;
}
