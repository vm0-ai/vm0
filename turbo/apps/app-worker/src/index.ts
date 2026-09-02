import icon192 from "../shell/icons/icon-192.bin";
import icon512Maskable from "../shell/icons/icon-512-maskable.bin";
import icon512 from "../shell/icons/icon-512.bin";
import indexHtml from "../shell/index.html";
import manifest from "../shell/manifest.txt";
import robots from "../shell/robots.txt";
import serviceWorker from "../shell/sw.txt";
import { createWorker } from "./worker.js";

export default createWorker({
  icon192,
  icon512,
  icon512Maskable,
  indexHtml,
  manifest,
  robots,
  serviceWorker,
});
