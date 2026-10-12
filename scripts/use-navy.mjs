// Publish the navy UI at the site root. The previous React app stays reachable as /legacy.html.
import { cpSync, renameSync, copyFileSync } from "node:fs";
renameSync("dist/index.html", "dist/legacy.html");
copyFileSync("preview/index.html", "dist/index.html");
cpSync("preview/assets", "dist/assets", { recursive: true });
