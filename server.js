const express = require("express");
const path = require("path");
const { S3Client, ListObjectsV2Command } = require("@aws-sdk/client-s3");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, "public")));

// ===== R2 CONFIG =====
const s3 = new S3Client({
  region: "auto",
  endpoint: process.env.R2_ENDPOINT,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  },
});

const BUCKET = process.env.R2_BUCKET;

// ===== CATEGORY LIST =====
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

// ===== API: LIST ALBUMS =====
app.get("/api/albums", async (req, res) => {
  try {
    const command = new ListObjectsV2Command({
      Bucket: BUCKET,
      Delimiter: "/",
    });

    const data = await s3.send(command);
    const folders = (data.CommonPrefixes || []).map(p =>
      p.Prefix.replace("/", "")
    );

    const albumsData = folders.map(folder => {
      const parts = folder.split("-");

      const day = parts[0] || "";
      const month = parts[1] || "";
      const year = parts[2] || "";

      const vsIndex = parts.findIndex(p => norm(p) === "vs");
      const beforeVs = vsIndex >= 0 ? parts.slice(3, vsIndex) : [];
      const afterVs = vsIndex >= 0 ? parts.slice(vsIndex + 1) : [];

      const club1 = beforeVs.join(" ").trim();

      let club2 = "";
      let category = "";
      let extra = "";

      if (afterVs.length) {
        const catIdx = findCategoryIndex(afterVs);
        club2 = afterVs.slice(0, catIdx).join(" ").trim();
        category = (afterVs[catIdx] || "").trim();
        extra = afterVs.slice(catIdx + 1).join(" ").trim();
      }

      const season = getSeason(year, month);

      return {
        name: folder,
        date: `${day}.${month}.${year}`,
        season,
        club1: club1.toUpperCase(),
        club2: club2.toUpperCase(),
        category: category.toUpperCase(),
        extra: extra.toUpperCase(),
        thumbnails: [
          `https://${BUCKET}.${process.env.R2_PUBLIC_DOMAIN}/${folder}/a.jpg`,
          `https://${BUCKET}.${process.env.R2_PUBLIC_DOMAIN}/${folder}/b.jpg`,
          `https://${BUCKET}.${process.env.R2_PUBLIC_DOMAIN}/${folder}/c.jpg`,
        ]
      };
    });

    albumsData.sort((a, b) => {
      const dateA = new Date(a.date.split(".").reverse().join("-"));
      const dateB = new Date(b.date.split(".").reverse().join("-"));
      return dateB - dateA;
    });

    res.json(albumsData);

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Greška pri čitanju albuma iz R2" });
  }
});

// ===== API: LIST IMAGES =====
app.get("/api/images/:album", async (req, res) => {
  const album = req.params.album;

  try {
    const command = new ListObjectsV2Command({
      Bucket: BUCKET,
      Prefix: `${album}/`,
    });

    const data = await s3.send(command);

    const images = (data.Contents || [])
      .map(obj => obj.Key.replace(`${album}/`, ""))
      .filter(name =>
        name &&
        !["a.jpg","b.jpg","c.jpg"].includes(name.toLowerCase())
      );

    res.json(images);

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Greška pri čitanju slika iz R2" });
  }
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Foto Backo server radi na http://localhost:${PORT}`);
});