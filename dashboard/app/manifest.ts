import type { MetadataRoute } from "next";

/** Installable app ("Add to Home Screen"): on iPhone, Web Push only works for an installed web app. */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Quant · LP Meteora",
    short_name: "Quant",
    description: "Screener dan uji paper LP Meteora DLMM",
    start_url: "/",
    display: "standalone",
    background_color: "#0b0e13",
    theme_color: "#0b0e13",
    icons: [
      { src: "/icon-192.png", sizes: "192x192", type: "image/png" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png" },
    ],
  };
}
