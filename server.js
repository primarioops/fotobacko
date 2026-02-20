const express = require("express");
const path = require("path");
const fs = require("fs");

const app = express();
const PORT = process.env.PORT || 3000;

const albumsPath = path.join(__dirname, "albums");

app.use(express.static(path.join(__dirname, "public")));
app.use("/albums", express.static(albumsPath));

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
  // Tražimo kategoriju s kraja (prva koja liči na kategoriju)
  for (let i = partsAfterVs.length - 1; i >= 0; i--) {
    const cand = norm(partsAfterVs[i]);
    if (CATEGORY_LIST.includes(cand)) return i;
  }
  // fallback: poslednji token kao kategorija
  return Math.max(partsAfterVs.length - 1, 0);
}

function pickThumb(files, base) {
  // prihvata a.jpg / a.JPG / a.jpeg / a.png
  const lower = files.map(f => f.toLowerCase());
  const candidates = [`${base}.jpg`, `${base}.jpeg`, `${base}.png`];
  for (const c of candidates) {
    const idx = lower.indexOf(c);
    if (idx >= 0) return files[idx];
  }
  return null;
}

app.get("/api/albums", (req, res) => {
  let folders;
  try {
    folders = fs.readdirSync(albumsPath, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(d => d.name);
  } catch (e) {
    return res.status(500).json({ error: "Greška pri čitanju albuma" });
  }

  const albumsData = folders.map((folder) => {
    // format: DD-MM-YYYY-<club1...>-vs-<club2...>-<category>-<extra...>
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
      // fallback minimalno
      club2 = "";
      category = (afterVs[0] || "").trim();
      extra = "";
    }

    const season = getSeason(year, month);

    let files = [];
    try {
      files = fs.readdirSync(path.join(albumsPath, folder));
    } catch {}

    const a = pickThumb(files, "a");
    const b = pickThumb(files, "b");
    const c = pickThumb(files, "c");

    const thumbnails = [a, b, c]
      .filter(Boolean)
      .map(f => `/albums/${folder}/${f}`);

    return {
      name: folder,
      date: `${day}.${month}.${year}`,
      season,
      club1: club1.toUpperCase(),
      club2: club2.toUpperCase(),
      category: category.toUpperCase(),
      extra: extra.toUpperCase(),
      thumbnails
    };
  });

  albumsData.sort((a, b) => {
    const dateA = new Date(a.date.split(".").reverse().join("-"));
    const dateB = new Date(b.date.split(".").reverse().join("-"));
    return dateB - dateA;
  });

  res.json(albumsData);
});

app.get("/api/images/:album", (req, res) => {
  const albumName = req.params.album;
  const albumPath = path.join(albumsPath, albumName);

  if (!fs.existsSync(albumPath)) {
    return res.status(404).json({ error: "Album ne postoji" });
  }

  let files;
  try {
    files = fs.readdirSync(albumPath);
  } catch (e) {
    return res.status(500).json({ error: "Greška pri čitanju slika" });
  }

  const images = files.filter(f => {
    const low = f.toLowerCase();
    if (!(low.endsWith(".jpg") || low.endsWith(".jpeg") || low.endsWith(".png"))) return false;
    // preskoči thumbnailove a/b/c
    if (low === "a.jpg" || low === "a.jpeg" || low === "a.png") return false;
    if (low === "b.jpg" || low === "b.jpeg" || low === "b.png") return false;
    if (low === "c.jpg" || low === "c.jpeg" || low === "c.png") return false;
    return true;
  });

  res.json(images);
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Foto Backo server radi na http://localhost:${PORT}`);
});