(function () {
  var root = document.getElementById("wa-root");
  if (!root) return;

  var avatar = document.getElementById("wa-avatar");
  var input = document.getElementById("wa-input");
  var nameLabel = document.getElementById("wa-name");
  var submitBtn = document.getElementById("wa-submit");
  var status = document.getElementById("wa-status");
  var overlay = document.getElementById("wa-overlay");
  var popup = document.getElementById("wa-popup");
  var manualRow = document.getElementById("wa-manual");
  var identityRows = root.querySelectorAll(".wa-identity");

  var stage = "idle"; // idle | auth | success
  var selected = null; // { id, name, emoji }
  var popupOpen = false;
  var authTimer = null;

  function openPopup() {
    popupOpen = true;
    overlay.style.display = "block";
    popup.style.display = "flex";
  }
  function closePopup() {
    popupOpen = false;
    overlay.style.display = "none";
    popup.style.display = "none";
  }

  function render() {
    if (stage === "auth") {
      avatar.textContent = "🫆";
      avatar.style.animation = "fingerPulse 0.9s ease-in-out infinite";
      status.style.display = "block";
      status.style.color = "#C94962";
      status.textContent = "Waiting for Touch ID / Windows Hello…";
    } else if (stage === "success") {
      avatar.textContent = "✅";
      avatar.style.animation = "";
      status.style.display = "block";
      status.style.color = "#3F9B57";
      status.textContent = "Verified — welcome back";
    } else {
      avatar.style.animation = "";
      status.style.display = "none";
      avatar.textContent = selected ? selected.emoji : "🔒";
    }

    if (selected) {
      input.style.display = "none";
      nameLabel.style.display = "block";
      nameLabel.textContent = selected.name;
    } else {
      input.style.display = "block";
      nameLabel.style.display = "none";
    }

    identityRows.forEach(function (row) {
      var isSelected = selected && row.dataset.id === selected.id;
      row.style.background = isSelected ? "#F6DADD" : "transparent";
      row.querySelector(".wa-check").style.display = isSelected ? "inline" : "none";
    });
  }

  avatar.addEventListener("click", function () {
    if (stage !== "idle") return;
    popupOpen ? closePopup() : openPopup();
  });
  overlay.addEventListener("click", closePopup);

  identityRows.forEach(function (row) {
    row.addEventListener("click", function () {
      selected = { id: row.dataset.id, name: row.dataset.name, emoji: row.dataset.emoji };
      closePopup();
      render();
    });
  });

  manualRow.addEventListener("click", function () {
    selected = null;
    closePopup();
    render();
  });

  submitBtn.addEventListener("click", function () {
    if (stage !== "idle") {
      if (authTimer) clearTimeout(authTimer);
      stage = "idle";
      selected = null;
      input.value = "";
      render();
      return;
    }
    if (!selected && !input.value.trim()) return;
    stage = "auth";
    render();
    authTimer = setTimeout(function () {
      stage = "success";
      render();
    }, 1300);
  });

  render();
})();
