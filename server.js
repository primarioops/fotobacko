const express = require("express");
const path = require("path");

const {
  S3Client,
  ListObjectsV2Command,
  GetObjectCommand,
} = require("@aws-sdk/client-s3");

const app = express();
const PORT = process.env.PORT || 3000;

// ====== R2 / S3 config ======
const R2_BUCKET = (process.env.R2_BUCKET || "").trim();

const accessKeyId = (
  process.env.AWS_ACCESS_KEY_ID ||
  process.env.R2_ACCESS_KEY ||
  ""
).trim();

const secretAccessKey = (
  process.env.AWS_SECRET_ACCESS_KEY ||
  process.env.R2_SECRET_KEY ||
  ""
).trim();

const R2_ENDPOINT = (process.env.R2_ENDPOINT || "").trim();

if (!R2_BUCKET) {
  throw new Error("Missing env: R2_BUCKET");
}
if (!R2_ENDPOINT) {
  throw new Error("Missing env: R2_ENDPOINT");
}
if (!accessKeyId || !secretAccessKey) {
  throw new Error(
    "Missing R2 credentials. Check AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY or R2_ACCESS_KEY/R2_SECRET_KEY in Render."
  );
}

const s3 = new S3Client({
  region: "auto",
  endpoint: R2_ENDPOINT,
  credentials: { accessKeyId, secretAccessKey },
});

// ====== static frontend ======
app.use(express.static(path.join(__dirname, "public")));

// ====== helpers ======
const CATEGORY_LIST = [
  "pretpetlići","pretpetlici",
  "petlići","petlici",
  "mlađi pioniri","mladji pioniri",
  "pioniri",
  "mlađi kadeti","mladji kadeti",
  "kadeti",
  "mlađi omladinci","mladji omladinci",
  "omladinci",
  "seniori",
  "veterani",
  "ostalo"
];

function norm(s) {
  return (s || "")
    .toLowerCase()
    .replace(/š/g, "s")
    .replace(/đ/g, "dj")
    .replace(/č/g, "c")
    .replace(/ć/g, "c")
    .replace(/ž/g, "z")
    .replace(/\s+/g, " ")
    .trim();
}

function getSeason(year, month) {
  const y = parseInt(year, 10);
  const m = parseInt(month, 10);
  if (!Number.isFinite(y) || !Number.isFinite(m)) return "";
  if (m >= 7) return `${y}-${String(y + 1).slice(-2)}`;
  return `${y - 1}-${String(y).slice(-2)}`;
}

function findCategoryIndex(partsAfterVs) {
  for (let i = partsAfterVs.length - 1; i >= 0; i--) {
    const cand = norm(partsAfterVs[i]);
    if (CATEGORY_LIST.includes(cand)) return i;
  }
  return Math.max(partsAfterVs.length - 1, 0);
}

function pickThumbFromKeys(keys, base) {
  // tražimo a.jpg / a.jpeg / a.png (case-insensitive)
  const lower = keys.map(k => k.toLowerCase());
  const candidates = [`${base}.jpg`, `${base}.jpeg`, `${base}.png`];
  for (const c of candidates) {
    const idx = lower.findIndex(k => k.endsWith("/" + c));
    if (idx >= 0) return keys[idx];
  }
  return null;
}

async function listAllKeys(prefix) {
  // vraća sve object keys za dati prefix
  let token = undefined;
  const out = [];
  do {
    const resp = await s3.send(
      new ListObjectsV2Command({
        Bucket: R2_BUCKET,
        Prefix: prefix,
        ContinuationToken: token,
      })
    );
    (resp.Contents || []).forEach(obj => {
      if (obj && obj.Key) out.push(obj.Key);
    });
    token = resp.IsTruncated ? resp.NextContinuationToken : undefined;
  } while (token);
  return out;
}

function keyToAlbumsUrl(key) {
  // key je npr "18-02-2026-.../a.jpg"
  // front očekuje /albums/<folder>/<file>
  return "/albums/" + key.split("/").map(encodeURIComponent).join("/");
}

// ====== API: list albums from R2 prefixes ======
app.get("/api/albums", async (req, res) => {
  try {
    // list "folders" (prefixes) at bucket root
    const resp = await s3.send(
      new ListObjectsV2Command({
        Bucket: R2_BUCKET,
        Delimiter: "/",
      })
    );

    const folders = (resp.CommonPrefixes || [])
      .map(p => (p.Prefix || "").replace(/\/$/, ""))
      .filter(Boolean);

    // Za svaki folder, uzmi listu fajlova (da nađeš a/b/c thumbnailove)
    const albumsData = [];
    for (const folder of folders) {
      const parts = folder.split("-");

      const day = parts[0] || "";
      const month = parts[1] || "";
      const year = parts[2] || "";

      const vsIndex = parts.findIndex(p => norm(p) === "vs");
      const beforeVs = vsIndex >= 0 ? parts.slice(3, vsIndex) : parts.slice(3, parts.length - 1);
      const afterVs = vsIndex >= 0 ? parts.slice(vsIndex + 1) : parts.slice(parts.length - 1);

      const club1 = beforeVs.join(" ").trim();

      let club2 = "";
      let category = "";
      let extra = "";

      if (vsIndex >= 0 && afterVs.length) {
        const catIdx = findCategoryIndex(afterVs);
        club2 = afterVs.slice(0, catIdx).join(" ").trim();
        category = (afterVs[catIdx] || "").trim();
        extra = afterVs.slice(catIdx + 1).join(" ").trim();
      } else {
        club2 = "";
        category = (afterVs[0] || "").trim();
        extra = "";
      }

      const season = getSeason(year, month);

      const keys = await listAllKeys(folder + "/");

      const aKey = pickThumbFromKeys(keys, "a");
      const bKey = pickThumbFromKeys(keys, "b");
      const cKey = pickThumbFromKeys(keys, "c");

      const thumbnails = [aKey, bKey, cKey]
        .filter(Boolean)
        .map(keyToAlbumsUrl);

      albumsData.push({
        name: folder,
        date: `${day}.${month}.${year}`,
        season,
        club1: club1.toUpperCase(),
        club2: club2.toUpperCase(),
        category: category.toUpperCase(),
        extra: extra.toUpperCase(),
        thumbnails
      });
    }

    albumsData.sort((a, b) => {
      const dateA = new Date(a.date.split(".").reverse().join("-"));
      const dateB = new Date(b.date.split(".").reverse().join("-"));
      return dateB - dateA;
    });

    res.json(albumsData);
  } catch (e) {
    console.error("R2 albums error:", e);
    res.status(500).json({ error: "Greška pri čitanju albuma iz R2" });
  }
});

// ====== API: list images for album from R2 ======
app.get("/api/images/:album", async (req, res) => {
  try {
    const albumName = decodeURIComponent(req.params.album || "");
    if (!albumName) return res.status(400).json({ error: "Album nije validan" });

    const keys = await listAllKeys(albumName + "/");
    if (!keys.length) return res.status(404).json({ error: "Album ne postoji" });

    const images = keys
      .filter(k => {
        const low = k.toLowerCase();
        if (!(low.endsWith(".jpg") || low.endsWith(".jpeg") || low.endsWith(".png"))) return false;
        // preskoči a/b/c
        if (low.endsWith("/a.jpg") || low.endsWith("/a.jpeg") || low.endsWith("/a.png")) return false;
        if (low.endsWith("/b.jpg") || low.endsWith("/b.jpeg") || low.endsWith("/b.png")) return false;
        if (low.endsWith("/c.jpg") || low.endsWith("/c.jpeg") || low.endsWith("/c.png")) return false;
        return true;
      })
      .map(k => k.split("/").pop()); // front očekuje samo imena fajlova

    res.json(images);
  } catch (e) {
    console.error("R2 images error:", e);
    res.status(500).json({ error: "Greška pri čitanju slika iz R2" });
  }
});

// ====== Serve images via /albums/... (proxy stream from R2) ======
app.get("/albums/:album/:file", async (req, res) => {
  try {
    const album = decodeURIComponent(req.params.album || "");
    const file = decodeURIComponent(req.params.file || "");
    if (!album || !file) return res.status(400).send("Bad request");

    const key = `${album}/${file}`;

    const obj = await s3.send(
      new GetObjectCommand({
        Bucket: R2_BUCKET,
        Key: key,
      })
    );

    // Content-Type i caching
    if (obj.ContentType) res.setHeader("Content-Type", obj.ContentType);
    res.setHeader("Cache-Control", "public, max-age=31536000, immutable");

    // Stream
    obj.Body.pipe(res);
  } catch (e) {
    console.error("R2 get object error:", e);
    res.status(404).send("Not found");
  }
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Foto Backo server radi na http://localhost:${PORT}`);
});
