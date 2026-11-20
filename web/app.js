const CENTER = [33.51, -88.62]; // roughly between Starkville, West Point, Columbus
const map = L.map("map").setView(CENTER, 10);

L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
  maxZoom: 18,
  attribution: "&copy; OpenStreetMap contributors",
}).addTo(map);

let ozLayer = null;
let ozProposedLayer = null;
let listings = [];
let auctionsData = { resources: [], listings: [] };
const markers = [];
const auctionMarkers = [];

const state = {
  tab: "forsale",
  city: "",
  ozOnly: true,
  type: "all",
  sort: "priceLow",
  flaggedOnly: false,
  minPrice: null,
  maxPrice: null,
};

// Matches the iPhone app's categories. RentCast types: Single Family, Condo,
// Townhouse, Manufactured, Multi-Family, Apartment, Land.
const TYPE_GROUPS = {
  houses: ["single family", "townhouse", "manufactured", "multi-family"],
  condos: ["condo", "apartment"],
  land: ["land"],
};

function matchesType(listing) {
  if (state.type === "all") return true;
  return TYPE_GROUPS[state.type].includes((listing.propertyType || "").toLowerCase());
}

function fmtPrice(p) {
  if (p == null) return "Price n/a";
  return "$" + Number(p).toLocaleString();
}

function ozBadge(listing) {
  if (listing.inOpportunityZone) {
    return '<span class="badge">Opportunity Zone</span>';
  }
  return '<span class="badge warn">Not in OZ</span>';
}

async function loadData() {
  const [oz2027Res, oz2018Res, listingsRes, auctionsRes] = await Promise.all([
    fetch("../data/opportunity_zones_2027.geojson").then((r) => r.json()),
    fetch("../data/opportunity_zones.geojson").then((r) => r.json()),
    fetch("../data/listings_cache.json").then((r) => r.json()),
    fetch("../data/auctions.json").then((r) => r.json()),
  ]);

  // Mississippi's OZ 2.0 tracts: approved by Treasury Nov 5, 2026, effective Jan 1, 2027.
  ozLayer = L.geoJSON(oz2027Res, {
    style: {
      color: "#4caf7d",
      weight: 2,
      fillColor: "#4caf7d",
      fillOpacity: 0.15,
    },
    onEachFeature: (feature, layer) => {
      const p = feature.properties || {};
      layer.bindPopup(
        `<strong>2027 Opportunity Zone</strong><br>Tract: ${p.GEOID}<br>${p.County}<br>${p.Rural_Status}<br><em>Approved Nov 5, 2026 &middot; effective Jan 1, 2027</em>`
      );
    },
  }).addTo(map);

  // Original 2018 designations, kept for reference (off by default).
  ozProposedLayer = L.geoJSON(oz2018Res, {
    style: {
      color: "#8a8f8c",
      weight: 1.5,
      dashArray: "6 4",
      fillColor: "#8a8f8c",
      fillOpacity: 0.05,
    },
    onEachFeature: (feature, layer) => {
      const p = feature.properties || {};
      layer.bindPopup(`<strong>2018 Opportunity Zone</strong><br>Tract: ${p.GEOID10}<br><em>Original designation, being replaced by the 2027 map.</em>`);
    },
  });

  listings = listingsRes.listings || [];
  auctionsData = auctionsRes || { resources: [], listings: [] };

  document.getElementById("listings-meta").textContent = listingsRes.fetchedAt
    ? `${listingsRes.count} listings, ${listingsRes.inOpportunityZoneCount} in OZ - updated ${new Date(listingsRes.fetchedAt).toLocaleString()}`
    : "No listing data yet - run scripts/fetch_listings.py with a RentCast API key.";

  renderForSale();
  renderAuctions();
}

function clearMarkers(arr) {
  arr.forEach((m) => map.removeLayer(m));
  arr.length = 0;
}

// ---- Flags (same rules as the iPhone app) ----
function daysAgo(dateStr) {
  if (!dateStr) return Infinity;
  const d = new Date(dateStr.slice(0, 10) + "T00:00:00Z");
  return Math.floor((Date.now() - d.getTime()) / 86400000);
}
function priceCutsFromHistory(l) {
  const cuts = [];
  let last = null;
  (l.history || []).forEach((e) => {
    if (e.price == null) return;
    if (last != null && e.price < last) cuts.push({ from: last, to: e.price, date: e.date });
    last = e.price;
  });
  return cuts;
}
function isNew(l) { return daysAgo(l.firstSeen) <= 3; }
function recentPriceCut(l) {
  const c = l.lastPriceChange;
  if (c && c.to < c.from && daysAgo(c.date) <= 14) return c;
  const cuts = priceCutsFromHistory(l);
  const last = cuts[cuts.length - 1];
  if (last && daysAgo(last.date) <= 14) return last;
  return null;
}
function isStale(l) { return (l.daysOnMarket || 0) >= 90; }
function pricePerSqft(l) { return l.price && l.squareFootage ? l.price / l.squareFootage : null; }

function flagBadges(l) {
  let html = "";
  if (isNew(l)) html += '<span class="badge flag-new">New</span>';
  const cut = recentPriceCut(l);
  if (cut) html += `<span class="badge flag-cut">Price cut −${Math.round((cut.from - cut.to) / 1000)}k</span>`;
  if (isStale(l)) html += `<span class="badge flag-stale">${l.daysOnMarket}+ days</span>`;
  return html;
}

const SORTERS = {
  priceLow: (a, b) => (a.price ?? Infinity) - (b.price ?? Infinity),
  priceHigh: (a, b) => (b.price ?? 0) - (a.price ?? 0),
  ppsf: (a, b) => (pricePerSqft(a) ?? Infinity) - (pricePerSqft(b) ?? Infinity),
  dom: (a, b) => (b.daysOnMarket ?? -1) - (a.daysOnMarket ?? -1),
  newest: (a, b) => ((b.firstSeen || "") + (b.listedDate || "")).localeCompare((a.firstSeen || "") + (a.listedDate || "")),
};

function filteredListings() {
  return listings.filter((l) => {
    if (state.flaggedOnly && !(isNew(l) || recentPriceCut(l) || isStale(l))) return false;
    if (state.city && l.city !== state.city) return false;
    if (state.ozOnly && !l.inOpportunityZone) return false;
    if (!matchesType(l)) return false;
    if (state.minPrice != null && (l.price ?? 0) < state.minPrice) return false;
    if (state.maxPrice != null && (l.price ?? 0) > state.maxPrice) return false;
    return true;
  }).sort(SORTERS[state.sort] || SORTERS.priceLow);
}

function renderForSale() {
  clearMarkers(markers);
  const listEl = document.getElementById("listings-list");
  listEl.innerHTML = "";

  const items = filteredListings();
  if (items.length === 0) {
    listEl.innerHTML = '<p class="meta">No listings match these filters yet.</p>';
  }

  items.forEach((l) => {
    if (l.latitude && l.longitude) {
      // Orange = recent price cut, blue = new, green = everything else.
      const color = recentPriceCut(l) ? "#e08a1e" : isNew(l) ? "#3b82f6" : "#4caf7d";
      const marker = L.circleMarker([l.latitude, l.longitude], {
        radius: 7,
        color,
        fillColor: color,
        fillOpacity: 0.8,
        weight: 1,
      }).addTo(map);
      marker.on("click", () => showDetail(l));
      markers.push(marker);
    }

    const card = document.createElement("div");
    card.className = "listing-card";
    card.innerHTML = `
      <div class="price">${fmtPrice(l.price)}${pricePerSqft(l) ? ` <span class="ppsf">$${Math.round(pricePerSqft(l))}/sqft</span>` : ""}</div>
      <div class="addr">${l.address || "Address unavailable"}</div>
      <div class="tags">
        ${flagBadges(l)}
        <span class="badge">${l.propertyType || "n/a"}</span>
        ${l.daysOnMarket != null ? `<span class="badge">${l.daysOnMarket} days</span>` : ""}
      </div>
    `;
    card.addEventListener("click", () => showDetail(l));
    listEl.appendChild(card);
  });
}

function renderAuctions() {
  clearMarkers(auctionMarkers);
  const listEl = document.getElementById("auctions-list");
  listEl.innerHTML = "";

  const resHeader = document.createElement("p");
  resHeader.className = "meta";
  resHeader.textContent = "Sources to check manually (no free auction API exists):";
  listEl.appendChild(resHeader);

  (auctionsData.resources || []).forEach((r) => {
    const card = document.createElement("div");
    card.className = "resource-card";
    card.innerHTML = `
      <div class="rname">${r.name} <span class="badge">${r.county}</span></div>
      <div class="rdesc">${r.description}</div>
      <a href="${r.url}" target="_blank" rel="noopener">${r.url}</a>
    `;
    listEl.appendChild(card);
  });

  const manual = (auctionsData.listings || []).filter((l) => !l._comment);
  if (manual.length) {
    const header = document.createElement("p");
    header.className = "meta";
    header.textContent = "Manually added auction / tax-sale properties:";
    listEl.appendChild(header);

    manual.forEach((l) => {
      if (l.latitude && l.longitude) {
        const marker = L.circleMarker([l.latitude, l.longitude], {
          radius: 7,
          color: "#d99a3a",
          fillColor: "#d99a3a",
          fillOpacity: 0.8,
          weight: 1,
        }).addTo(map);
        auctionMarkers.push(marker);
      }
      const card = document.createElement("div");
      card.className = "auction-card";
      card.innerHTML = `
        <div class="price">${l.openingBid ? fmtPrice(l.openingBid) : "Opening bid n/a"}</div>
        <div class="addr">${l.address}</div>
        <div class="tags">
          <span class="badge">${l.auctionType || "Auction"}</span>
          ${l.auctionDate ? `<span class="badge">${l.auctionDate}</span>` : ""}
        </div>
      `;
      listEl.appendChild(card);
    });
  }
}

function historyHtml(l) {
  const events = (l.history || []).slice().reverse();
  if (!events.length) return "";
  const first = (l.history || []).find((e) => e.price != null);
  const drop = first && l.price && l.price < first.price ? first.price - l.price : null;
  return `
    <h3>Price history</h3>
    ${drop ? `<div class="row"><span>Down from original price</span><span class="drop">${fmtPrice(drop)}</span></div>` : ""}
    ${events.map((e) => `<div class="row"><span>${e.date} &middot; ${e.event || "Update"}</span><span>${e.price != null ? fmtPrice(e.price) : ""}</span></div>`).join("")}
  `;
}

function zillowUrl(l) {
  if (!l.address) return null;
  const slug = l.address.replace(/#/g, "").split(/\s+/).join("-");
  return `https://www.zillow.com/homes/${encodeURI(slug)}_rb/`;
}

function showDetail(l) {
  const card = document.getElementById("detail-card");
  const z = zillowUrl(l);
  card.innerHTML = `
    <h2>${l.address || "Listing"}</h2>
    <div class="tags" style="margin-bottom:8px">${flagBadges(l)}</div>
    ${z ? `<p><a href="${z}" target="_blank" rel="noopener">See listing photos on Zillow</a></p>` : ""}
    <div class="row"><span>Price</span><span>${fmtPrice(l.price)}</span></div>
    <div class="row"><span>Price / sq ft</span><span>${pricePerSqft(l) ? "$" + Math.round(pricePerSqft(l)) : "n/a"}</span></div>
    <div class="row"><span>Status</span><span>${l.status || "n/a"}</span></div>
    <div class="row"><span>Type</span><span>${l.propertyType || "n/a"}</span></div>
    <div class="row"><span>Beds / Baths</span><span>${l.bedrooms ?? "?"} / ${l.bathrooms ?? "?"}</span></div>
    <div class="row"><span>Sq Ft</span><span>${l.squareFootage ?? "n/a"}</span></div>
    <div class="row"><span>Year Built</span><span>${l.yearBuilt ?? "n/a"}</span></div>
    <div class="row"><span>Days on Market</span><span>${l.daysOnMarket ?? "n/a"}</span></div>
    <div class="row"><span>Opportunity Zone</span><span>${l.inOpportunityZone ? "Yes (" + l.opportunityZoneTract + ")" : "No"}</span></div>
    <div class="row"><span>County</span><span>${l.county || "n/a"}</span></div>
    <div class="row"><span>First seen by tracker</span><span>${l.firstSeen || "n/a"}</span></div>
    ${historyHtml(l)}
    <button class="close-btn" id="detail-close">Close</button>
  `;
  document.getElementById("detail-overlay").classList.remove("hidden");
  document.getElementById("detail-close").addEventListener("click", () => {
    document.getElementById("detail-overlay").classList.add("hidden");
  });
}

document.querySelectorAll(".tab").forEach((tab) => {
  tab.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach((t) => t.classList.remove("active"));
    tab.classList.add("active");
    state.tab = tab.dataset.tab;
    const isForSale = state.tab === "forsale";
    document.getElementById("forsale-filters").classList.toggle("hidden", !isForSale);
    document.getElementById("listings-list").classList.toggle("hidden", !isForSale);
    document.getElementById("auctions-list").classList.toggle("hidden", isForSale);
  });
});

document.getElementById("filter-city").addEventListener("change", (e) => {
  state.city = e.target.value;
  renderForSale();
});
document.getElementById("filter-oz-only").addEventListener("change", (e) => {
  state.ozOnly = e.target.checked;
  renderForSale();
});
document.getElementById("filter-sort").addEventListener("change", (e) => {
  state.sort = e.target.value;
  renderForSale();
});
document.getElementById("filter-flagged").addEventListener("change", (e) => {
  state.flaggedOnly = e.target.checked;
  renderForSale();
});
document.getElementById("filter-type").addEventListener("change", (e) => {
  state.type = e.target.value;
  renderForSale();
});
document.getElementById("filter-min-price").addEventListener("input", (e) => {
  state.minPrice = e.target.value ? Number(e.target.value) : null;
  renderForSale();
});
document.getElementById("filter-max-price").addEventListener("input", (e) => {
  state.maxPrice = e.target.value ? Number(e.target.value) : null;
  renderForSale();
});

document.getElementById("toggle-current-oz").addEventListener("change", (e) => {
  if (!ozLayer) return;
  if (e.target.checked) {
    ozLayer.addTo(map);
  } else {
    map.removeLayer(ozLayer);
  }
});
document.getElementById("toggle-proposed-oz").addEventListener("change", (e) => {
  if (!ozProposedLayer) return;
  if (e.target.checked) {
    ozProposedLayer.addTo(map);
  } else {
    map.removeLayer(ozProposedLayer);
  }
});

loadData();
