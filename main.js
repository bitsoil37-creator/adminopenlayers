/* Initialize MapLibre + Firebase realtime updates */
maplibregl.accessToken = 'none';

/* === SAFETY: disable all MapLibre popups from being added/displayed ===
   This overrides Popup.addTo so any code that tries to show a popup
   (marker.setPopup(popup).addTo(map) or popup.addTo(map)) becomes a no-op.
   That guarantees ZERO MapLibre popup UI ever appears.
   (We keep your popup DOM creation intact for your positioning/advisory logic,
   but MapLibre will never attach/display it.)
*/
if (maplibregl && maplibregl.Popup && maplibregl.Popup.prototype) {
  maplibregl.Popup.prototype.addTo = function() {
    // no-op: prevent any popup from being added to the map
    return this;
  };
}

/* Firebase */
import { initializeApp } from "https://www.gstatic.com/firebasejs/11.0.1/firebase-app.js";
import { getDatabase, ref, onValue, set } from "https://www.gstatic.com/firebasejs/11.0.1/firebase-database.js";

/* --- Firebase Config --- */
const firebaseConfig = {
  databaseURL: "https://soilbitchina-default-rtdb.firebaseio.com/"
};
const app = initializeApp(firebaseConfig);
const db = getDatabase(app);

/* --- Parameters and Ranges --- */
const params = [
  "Temperature", "Moisture", "pH", "Salinity",
  "EC", "Nitrogen", "Phosphorus", "Potassium"
];

const ranges = {
  "pH": [6.00, 6.50],
  "Moisture": [30.00, 50.00],
  "Temperature": [18.00, 24.00],
  "Salinity": [0.50, 2.00],
  "EC": [0.50, 2.00],
  "Nitrogen": [80.00, 120.00],
  "Phosphorus": [20.00, 40.00],
  "Potassium": [80.00, 120.00]
};

const messages = {
  "pH": {
    low: "Soil pH is too low — acidic soil reduces nutrient availability and stunts growth.",
    high: "Soil pH is too high — alkaline soil locks nutrients and weakens plants."
  },
  "Moisture": {
    low: "Soil is too dry — roots can't absorb enough water or nutrients.",
    high: "Soil is waterlogged — risk of root rot and poor plant health."
  },
  "Temperature": {
    low: "Soil is too cold — growth slows and flowering is delayed.",
    high: "Soil is too hot — plants are stressed and yield may drop."
  },
  "Salinity": {
    low: "Soil salinity is too low — may cause nutrient imbalance.",
    high: "Soil salinity is too high — roots are damaged and leaves may burn."
  },
  "Nitrogen": {
    low: "Nitrogen is too low — leaves turn yellow, growth slows.",
    high: "Nitrogen is too high — excess leaves form, flowering is delayed."
  },
  "Phosphorus": {
    low: "Phosphorus is too low — weak roots and poor flowering.",
    high: "Phosphorus is too high — micronutrient uptake is blocked, growth suffers."
  },
  "Potassium": {
    low: "Potassium is too low — plants are weak, bean quality drops.",
    high: "Potassium is too high — calcium and magnesium uptake is disrupted."
  },
  "EC": {
    low: "EC is too low — may cause nutrient imbalance.",
    high: "EC is too high — roots are damaged and leaves may burn."
  },
};

/* --- Admin username from URL --- */
const adminUsername = new URLSearchParams(window.location.search).get("admin");
if (!adminUsername) {
  alert("⚠️ Please provide an admin username in the URL (e.g. ?admin=bacofa)");
  throw new Error("Admin username missing");
}

const map = new maplibregl.Map({
  container: 'map',
  style: {
    version: 8,
    sources: {
      satellite: {
        type: 'raster',
        tiles: [
          `https://api.maptiler.com/maps/satellite/256/{z}/{x}/{y}.jpg?key=k0zBlTOs7WrHcJIfCohH`
        ],
        tileSize: 256,
        attribution:
          '<a href="https://www.maptiler.com/" target="_blank">© MapTiler</a> © OpenStreetMap contributors'
      }
    },
    layers: [
      {
        id: 'satellite-layer',
        type: 'raster',
        source: 'satellite',
        minzoom: 0,
        maxzoom: 22
      }
    ]
  },
  center: [0, 0],
  zoom: 1,
  bearing: 0,
  pitch: 0
});


let markers = {};
let suppressUpdate = false;
let isAdminValid = false; // Flag to check if admin is valid

/* --- Extra safety: remove any existing popup DOM when page loads --- */
document.addEventListener('DOMContentLoaded', () => {
  document.querySelectorAll('.maplibregl-popup').forEach(p => p.remove());
});

/* --- Extra safety: remove any popup DOM on map click (in case something created one) --- */
map.on('click', () => {
  document.querySelectorAll('.maplibregl-popup').forEach(p => p.remove());
  // also hide global advisory to be safe (your advisory is separate)
  const ga = document.getElementById('global-advisory');
  if (ga) ga.style.display = 'none';
});

/* --- Firebase Realtime Updates --- */
map.on("load", () => {
  // extra cleanup at load
  document.querySelectorAll('.maplibregl-popup').forEach(p => p.remove());

  // FIRST: Check if the provided admin username is valid
  const adminRef = ref(db, `Admin/${adminUsername}`);
  onValue(adminRef, (adminSnapshot) => {
    const adminData = adminSnapshot.val();
    
    if (!adminData) {
      // Invalid admin username
      alert(`❌ Access Denied: Admin username "${adminUsername}" not found`);
      // Optionally hide the map or show error message
      document.getElementById('map').style.display = 'none';
      throw new Error("Invalid admin username");
    }
    
    // Admin is valid, set flag and proceed to load all users
    isAdminValid = true;
    console.log(`✅ Admin access granted: ${adminUsername}`);
    
    // Now load ALL users data
    const usersRef = ref(db, `Users`);
    onValue(usersRef, (usersSnapshot) => {
      if (suppressUpdate || !isAdminValid) return;
      const allUsersData = usersSnapshot.val();
      if (allUsersData) {
        // Clear all existing markers
        Object.values(markers).forEach(marker => marker.remove());
        markers = {};
        
        // Process each user's nodes
        Object.entries(allUsersData).forEach(([username, userData]) => {
          if (userData && userData.Farm && userData.Farm.Nodes) {
            updateMapForUser(userData.Farm.Nodes, username);
          }
        });
        
        // REMOVED: Automatic zoom to most common country
        // The map will stay at the initial zoom level (zoom: 1, center: [0, 0])
        // which shows the entire world
      }
    });
  });
});

/* --- Update Map for a Specific User --- */
function updateMapForUser(nodesData, username) {
  Object.entries(nodesData).forEach(([nodeName, nodeData]) => {
    const coords = nodeData.Coordinates;
    if (!coords || coords.X === undefined || coords.Y === undefined) {
      console.warn(`${nodeName} (${username}) skipped: missing coordinates`);
      return;
    }

    const packets = Object.values(nodeData.Packets || {});
    const latestPacket = packets.length > 0 ? packets[packets.length - 1] : null;

    // Create a unique marker ID combining username and node name
    const markerId = `${username}_${nodeName}`;
    
    if (markers[markerId]) markers[markerId].remove();

    // If no packets, marker is grey
    const markerColor = latestPacket ? "red" : "grey";

    const marker = new maplibregl.Marker({ color: markerColor })
      .setLngLat([coords.X, coords.Y])
      .addTo(map);

    /* ------------- THE CHANGE YOU REQUESTED -------------- */
    // Ensure marker cannot be clicked/tapped
    const el = marker.getElement();
    if (el) el.style.pointerEvents = "none";
    /* ------------------------------------------------------ */

    const container = document.createElement("div");
    container.className = "popup-content";
    container.style.fontFamily = "'Segoe UI', Tahoma, Geneva, Verdana, sans-serif";

    // CHANGED: Include username in the title
    const title = document.createElement("h3");
    title.textContent = `${nodeName} (${username})`;
    title.style.textAlign = "center";
    container.appendChild(title);

    if (!latestPacket) {
      const noData = document.createElement("p");
      noData.textContent = "No data available yet.";
      noData.style.textAlign = "center";
      container.appendChild(noData);
    } else {
      params.forEach((param, i) => {
        const row = document.createElement("div");
        row.className = `param-row ${i >= 4 ? "extra hidden" : ""}`;

        const label = document.createElement("span");
        label.textContent = param;
        label.className = "param-label";

        const value = parseFloat(latestPacket[param.toLowerCase()]) || 0;
        const [min, max] = ranges[param] || [0, 100];
        let percent = 0;

        if (param === "pH") percent = ((value - 3) / (9 - 3)) * 100;
        else if (param === "Moisture") percent = value;
        else if (param === "Temperature") percent = ((value - (-30)) / (70 - (-30))) * 100;
        else percent =
          (Math.log10(Math.max(value, 0.01)) - Math.log10(0.01)) /
          (Math.log10(20) - Math.log10(0.01)) * 100;

        const barContainer = document.createElement("div");
        barContainer.className = "bar-container";
        const bar = document.createElement("div");
        bar.className = "bar";
        bar.style.width = Math.min(Math.max(percent, 0), 100) + "%";
        const inRange = value >= min && value <= max;
        bar.style.background = inRange ? "darkgreen" : "red";

        const barLines = document.createElement("div");
        barLines.className = "bar-lines";
        for (let j = 1; j < 10; j++) barLines.appendChild(document.createElement("div"));

        barContainer.append(bar, barLines);

        const info = document.createElement("button");
        info.textContent = "ℹ️";
        info.className = "info-btn";

        const disabledFlag = latestPacket[`Disabled_${param}_done`];
        const shouldDisable = inRange || disabledFlag !== undefined;

        info.disabled = shouldDisable;
        info.style.opacity = shouldDisable ? "0.3" : "1.0";
        info.style.cursor = shouldDisable ? "not-allowed" : "pointer";

        info.onclick = () => {
          if (info.disabled) return;

          const globalAdvisory = document.getElementById("global-advisory");
          const popupEl = document.querySelector(".maplibregl-popup-content");

          if (
            globalAdvisory.dataset.activeNode === markerId &&
            globalAdvisory.dataset.activeParam === param
          ) {
            globalAdvisory.style.display = "none";
            globalAdvisory.dataset.activeNode = "";
            globalAdvisory.dataset.activeParam = "";
            return;
          }

          const message = value < min ? messages[param].low : messages[param].high;
          globalAdvisory.innerHTML = `
            <p class="advisory-text">${message}</p>
            <button id="doneBtn" class="done-btn">Done</button>
            <p class="note-text">
              Note: For parameters like NPK, EC, and pH, changes may take time or days to appear.
              If an action is performed, please wait before checking results.
            </p>
          `;
          globalAdvisory.style.display = "block";
          globalAdvisory.dataset.activeNode = markerId;
          globalAdvisory.dataset.activeParam = param;

          function updateAdvisoryPosition() {
            const popup = document.querySelector(".maplibregl-popup-content");
            if (popup && globalAdvisory.style.display === "block") {
              const rect = popup.getBoundingClientRect();
              globalAdvisory.style.top = `${rect.bottom + window.scrollY + 8}px`;
              globalAdvisory.style.left = `${
                rect.left + window.scrollX + rect.width / 2 - globalAdvisory.offsetWidth / 2
              }px`;
            }
          }
          updateAdvisoryPosition();
          map.on("move", updateAdvisoryPosition);
          map.on("zoom", updateAdvisoryPosition);
          const popupObserver = new MutationObserver(updateAdvisoryPosition);
          if (popupEl) popupObserver.observe(popupEl, { childList: true, subtree: true });

          document.getElementById("doneBtn").onclick = async () => {
            try {
              suppressUpdate = true;
              const timeClicked = Date.now();
              const disabledKey = `Disabled_${param}_done`;
              const packetKeys = Object.keys(nodeData.Packets || {});
              if (packetKeys.length === 0) return;
              const latestKey = packetKeys[packetKeys.length - 1];
              // CHANGED: Use the correct path with username
              const disabledPath = `Users/${username}/Farm/Nodes/${nodeName}/Packets/${latestKey}/${disabledKey}`;
              await set(ref(db, disabledPath), timeClicked);
              info.disabled = true;
              info.style.opacity = "0.3";
              info.style.cursor = "not-allowed";
              globalAdvisory.style.display = "none";
              setTimeout(() => (suppressUpdate = false), 2000);
            } catch (err) {
              console.error("❌ Error disabling:", err);
              suppressUpdate = false;
            }
          };
        };

        row.append(label, barContainer, info);
        container.appendChild(row);
      });
    }

    const toggleBtn = document.createElement("button");
    toggleBtn.className = "toggle-btn";
    toggleBtn.textContent = "⬇️";
    toggleBtn.onclick = () => {
      const extras = container.querySelectorAll(".extra");
      const hidden = extras[0]?.classList.contains("hidden");
      extras.forEach((e) => e.classList.toggle("hidden", !hidden));
      toggleBtn.textContent = hidden ? "⬆️" : "⬇️";
    };
    container.append(toggleBtn);

    const popup = new maplibregl.Popup({
      closeButton: true,
      closeOnClick: false,
      offset: [15, -15],
      anchor: "left",
    }).setDOMContent(container);

    /* ------------- THE CHANGE YOU REQUESTED -------------- */
    // marker.setPopup(popup);  // ← REMOVED SO MARKER CANNOT OPEN POPUPS
    /* ------------------------------------------------------ */

    markers[markerId] = marker;

    popup.on("close", () => {
      const ga = document.getElementById("global-advisory");
      if (ga) ga.style.display = "none";
    });
  });
}
