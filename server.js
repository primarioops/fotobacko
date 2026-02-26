const express = require("express");
const path = require("path");
const multer = require("multer");
const {
  S3Client,
  ListObjectsV2Command,
  GetObjectCommand,
  PutObjectCommand,
  DeleteObjectsCommand,
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
const ADMIN_PASSWORD = (process.env.ADMIN_PASSWORD || "").trim();
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
if (!ADMIN_PASSWORD) {
  console.log("WARNING: ADMIN_PASSWORD missing");
}
const s3 = new S3Client({
  region: "auto",
  endpoint: R2_ENDPOINT,
  credentials: { accessKeyId, secretAccessKey },
});

// ====== static frontend ======
app.use(express.static(path.join(__dirname, "public")));
app.use(express.json({ limit: "1mb" }));
// ====== admin auth (simple) ======
function requireAdmin(req, res, next) {
  // očekujemo header: x-admin-password: <tvoja_lozinka>
  const pass = String(req.headers["x-admin-password"] || "").trim();

  if (!pass || pass !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 } // 25MB
});
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
    const resp = await s3.send(
      new ListObjectsV2Command({
        Bucket: R2_BUCKET,
        Delimiter: "/",
      })
    );

    const folders = (resp.CommonPrefixes || [])
      .map(p => (p.Prefix || "").replace(/\/$/, ""))
      .filter(Boolean);

    const albumsData = [];

    for (const folder of folders) {
      const parts = folder.split("-");

      const day = parts[0] || "";
      const month = parts[1] || "";
      const year = parts[2] || "";

      const vsIndex = parts.findIndex(p => norm(p) === "vs");

      const beforeVs = vsIndex >= 0 ? parts.slice(3, vsIndex) : parts.slice(3);
      const afterVs = vsIndex >= 0 ? parts.slice(vsIndex + 1) : [];

      const club1 = beforeVs.join(" ").trim();

      let club2 = "";
      let extra = "";

      if (afterVs.length) {
        const separatorIndex = afterVs.findIndex(p => p === "");
        if (separatorIndex !== -1) {
          club2 = afterVs.slice(0, separatorIndex).join(" ").trim();
          extra = afterVs.slice(separatorIndex + 1).join(" ").trim();
        } else {
          club2 = afterVs.join(" ").trim();
          extra = "";
        }
      }

      const season = getSeason(year, month);

      const keys = await listAllKeys(folder + "/");

      // preskoči prazan album
      const hasImages = keys.some(k => {
        const low = k.toLowerCase();
        return low.endsWith(".jpg") || low.endsWith(".jpeg") || low.endsWith(".png");
      });
      if (!hasImages) continue;

      const aKey = pickThumbFromKeys(keys, "a");
      const bKey = pickThumbFromKeys(keys, "b");
      const cKey = pickThumbFromKeys(keys, "c");

      const thumbnails = [aKey, bKey, cKey]
        .filter(Boolean)
        .map(keyToAlbumsUrl);

      albumsData.push({
        name: folder,
        date: `${day}.${month}.${year}.`,
        season,
        club1: club1.toUpperCase(),
        club2: club2.toUpperCase(),
        category: "",
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

// ====== API: list images for album (query param, radi i sa ž/š/ć) ======
app.get("/api/images", async (req, res) => {
  try {
    const albumName = String(req.query.name || "");
    if (!albumName) return res.status(400).json({ error: "Album nije validan" });

    const keys = await listAllKeys(albumName + "/");
    if (!keys.length) return res.status(404).json({ error: "Album ne postoji" });

    const images = keys
      .filter(k => {
        const low = k.toLowerCase();
        if (!(low.endsWith(".jpg") || low.endsWith(".jpeg") || low.endsWith(".png"))) return false;
        if (low.endsWith("/a.jpg") || low.endsWith("/a.jpeg") || low.endsWith("/a.png")) return false;
        if (low.endsWith("/b.jpg") || low.endsWith("/b.jpeg") || low.endsWith("/b.png")) return false;
        if (low.endsWith("/c.jpg") || low.endsWith("/c.jpeg") || low.endsWith("/c.png")) return false;
        return true;
      })
      .map(k => k.split("/").pop());

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
// ====== ADMIN: upload image to R2 ======
app.post(
  "/api/admin/upload",
  requireAdmin,
  upload.single("file"),
  async (req, res) => {
    try {
      const album = String(req.body.album || "").trim();
      if (!album) return res.status(400).json({ error: "Missing album" });

      if (!req.file) return res.status(400).json({ error: "Missing file" });

      const original = String(req.file.originalname || "upload.jpg");
      const safeName = original.replace(/[^a-zA-Z0-9.-]/g, "");

      const key = `${album}/${safeName}`;

      await s3.send(
        new PutObjectCommand({
          Bucket: R2_BUCKET,
          Key: key,
          Body: req.file.buffer,
          ContentType: req.file.mimetype || "application/octet-stream",
          CacheControl: "public, max-age=31536000, immutable",
        })
      );

      res.json({ ok: true, key });
    } catch (e) {
      console.error("Upload error:", e);
      res.status(500).json({ error: "Upload failed" });
    }
  }
);
// ====== ADMIN: delete whole album (prefix) from R2 ======
app.delete("/api/admin/album", requireAdmin, async (req, res) => {
  try {
    const album = String((req.body && req.body.album) || "").trim();
    if (!album) {
      return res.status(400).json({ error: "Missing album" });
    }

    const prefix = album.endsWith("/") ? album : album + "/";

    let deleted = 0;
    let token = undefined;

    while (true) {

      const resp = await s3.send(
        new ListObjectsV2Command({
          Bucket: R2_BUCKET,
          Prefix: prefix,
          ContinuationToken: token,
          MaxKeys: 1000,
        })
      );

      const keys = (resp.Contents || [])
        .map(obj => obj && obj.Key)
        .filter(Boolean);

      // ako nema više fajlova — prekini
      if (!keys.length) break;

      await s3.send(
        new DeleteObjectsCommand({
          Bucket: R2_BUCKET,
          Delete: {
            Objects: keys.map(Key => ({ Key })),
            Quiet: true,
          },
        })
      );

      deleted += keys.length;

      if (!resp.IsTruncated) break;

      token = resp.NextContinuationToken;
    }

    return res.json({
      ok: true,
      album,
      deleted
    });

  } catch (e) {
    console.error("Delete album error:", e);
    return res.status(500).json({ error: "Delete failed" });
  }
});
// ====== START SERVER ======
app.listen(PORT, "0.0.0.0", () => {
  console.log(`Foto Backo server radi na portu ${PORT}`);
});
