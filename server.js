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
const R2_PUBLIC_URL = "https://pub-6f722da185574126ba7b1069d1ab1f45.r2.dev";
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
  const pass = String(req.headers["x-admin-password"] || "").trim();

  if (!pass || pass !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 }, // 25MB
});

// ====== helpers ======
const CATEGORY_LIST = [
  "pretpetlići", "pretpetlici",
  "petlići", "petlici",
  "mlađi pioniri", "mladji pioniri",
  "pioniri",
  "mlađi kadeti", "mladji kadeti",
  "kadeti",
  "mlađi omladinci", "mladji omladinci",
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
  const lower = keys.map(k => k.toLowerCase());
  const candidates = [`${base}.jpg`, `${base}.jpeg`, `${base}.png`];
  for (const c of candidates) {
    const idx = lower.findIndex(k => k.endsWith("/" + c));
    if (idx >= 0) return keys[idx];
  }
  return null;
}

async function listAllKeys(prefix) {
  let token = undefined;
  const out = [];

  do {
    const resp = await s3.send(
      new ListObjectsV2Command({
        Bucket: R2_BUCKET,
        Prefix: prefix,
        ContinuationToken: token,
        MaxKeys: 1000,
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
  return R2_PUBLIC_URL + "/" + key.split("/").map(encodeURIComponent).join("/");
}

function parseAlbumFolder(folder) {
  const parts = folder.split("-");

  const day = parts[0] || "";
  const month = parts[1] || "";
  const year = parts[2] || "";

  const vsIndex = parts.findIndex(p => norm(p) === "vs");

  const beforeVs = vsIndex >= 0 ? parts.slice(3, vsIndex) : parts.slice(3);
  const afterVs = vsIndex >= 0 ? parts.slice(vsIndex + 1) : [];

  const club1 = beforeVs.join(" ").trim();

  let club2 = "";
  let category = "";
  let extra = "";

  if (afterVs.length) {
    const categoryIndex = findCategoryIndex(afterVs);

    if (categoryIndex >= 0) {
      club2 = afterVs.slice(0, categoryIndex).join(" ").trim();
      category = afterVs[categoryIndex] || "";
      extra = afterVs.slice(categoryIndex + 1).join(" ").trim();
    } else {
      club2 = afterVs.join(" ").trim();
    }
  }

  return {
    day,
    month,
    year,
    club1,
    club2,
    category,
    extra,
  };
}

function parseDateToTime(dateString) {
  const parts = String(dateString || "").split(".").filter(Boolean);
  if (parts.length !== 3) return 0;
  const [day, month, year] = parts;
  return new Date(`${year}-${month}-${day}`).getTime();
}

// ====== cache for albums ======
let albumsCache = null;
let albumsCacheTime = 0;
const ALBUMS_CACHE_TTL = 60 * 1000; // 60 sekundi

function clearAlbumsCache() {
  albumsCache = null;
  albumsCacheTime = 0;
}

// ====== API: list albums from R2 ======
app.get("/api/albums", async (req, res) => {
  try {
    if (albumsCache && Date.now() - albumsCacheTime < ALBUMS_CACHE_TTL) {
      return res.json(albumsCache);
    }

    let token = undefined;
    const albumsMap = {};

    do {
      const resp = await s3.send(
        new ListObjectsV2Command({
          Bucket: R2_BUCKET,
          ContinuationToken: token,
          MaxKeys: 1000,
        })
      );

      const objects = resp.Contents || [];

      for (const obj of objects) {
        if (!obj || !obj.Key) continue;

        const key = obj.Key;
        const parts = key.split("/");

        if (parts.length < 2) continue;

        const folder = parts[0];
        const file = parts[1];

        if (!folder || !file) continue;

        const low = file.toLowerCase();
        const isThumb =
          low === "a.jpg" ||
          low === "a.jpeg" ||
          low === "a.png";

        if (!isThumb) continue;

        if (!albumsMap[folder]) {
          const parsed = parseAlbumFolder(folder);

          albumsMap[folder] = {
            name: folder,
            date: `${parsed.day}.${parsed.month}.${parsed.year}.`,
            season: getSeason(parsed.year, parsed.month),
            club1: parsed.club1.toUpperCase(),
            club2: parsed.club2.toUpperCase(),
            category: parsed.category.toUpperCase(),
            extra: parsed.extra.toUpperCase(),
            thumbnails: [keyToAlbumsUrl(key)],
          };
        }
      }

      token = resp.IsTruncated ? resp.NextContinuationToken : undefined;
    } while (token);

    const albumsData = Object.values(albumsMap);

    albumsData.sort((a, b) => {
      return parseDateToTime(b.date) - parseDateToTime(a.date);
    });

    albumsCache = albumsData;
    albumsCacheTime = Date.now();

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
    if (!albumName) {
      return res.status(400).json({ error: "Album nije validan" });
    }

    const keys = await listAllKeys(albumName + "/");
    if (!keys.length) {
      return res.status(404).json({ error: "Album ne postoji" });
    }

    const images = keys
      .filter(k => {
        const low = k.toLowerCase();
        if (!(low.endsWith(".jpg") || low.endsWith(".jpeg") || low.endsWith(".png"))) {
          return false;
        }
        if (low.endsWith("/a.jpg") || low.endsWith("/a.jpeg") || low.endsWith("/a.png")) {
          return false;
        }
        if (low.endsWith("/b.jpg") || low.endsWith("/b.jpeg") || low.endsWith("/b.png")) {
          return false;
        }
        if (low.endsWith("/c.jpg") || low.endsWith("/c.jpeg") || low.endsWith("/c.png")) {
          return false;
        }
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

    if (!album || !file) {
      return res.status(400).send("Bad request");
    }

    const key = `${album}/${file}`;

    const obj = await s3.send(
      new GetObjectCommand({
        Bucket: R2_BUCKET,
        Key: key,
      })
    );

    if (obj.ContentType) {
      res.setHeader("Content-Type", obj.ContentType);
    }
    res.setHeader("Cache-Control", "public, max-age=31536000, immutable");

    if (!obj.Body) {
      return res.status(404).send("Not found");
    }

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
      if (!album) {
        return res.status(400).json({ error: "Missing album" });
      }

      if (!req.file) {
        return res.status(400).json({ error: "Missing file" });
      }

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

      clearAlbumsCache();

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

    clearAlbumsCache();

    return res.json({
      ok: true,
      album,
      deleted,
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
