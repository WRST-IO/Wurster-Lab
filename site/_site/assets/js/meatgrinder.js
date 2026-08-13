(function () {
  var idle = document.getElementById("mg-idle");
  var dropped = document.getElementById("mg-dropped");
  var processing = document.getElementById("mg-processing");
  var done = document.getElementById("mg-done");
  if (!idle || !dropped || !processing || !done) return;

  var fileInfo = document.getElementById("mg-file-info");
  var fname = document.getElementById("mg-fname");
  var fsize = document.getElementById("mg-fsize");
  var fformat = document.getElementById("mg-fformat");
  var browseBtn = document.getElementById("mg-browse");
  var fileInput = document.getElementById("mg-file-input");
  var startBtn = document.getElementById("mg-start");
  var resetBtn = document.getElementById("mg-reset");
  var downloadBtn = document.getElementById("mg-download");
  var progressFill = document.getElementById("mg-progress-fill");
  var statusText = document.getElementById("mg-status");
  var comicText = document.getElementById("mg-comic");

  var currentFile = { name: "my-project.zip", size: "4.2 MB", format: "ZIP Archive" };
  var progressTimer = null;

  var STATUS_TEXT = [
    [20, "Slicing your app into strips…"],
    [40, "Rendering the fat…"],
    [60, "Mixing in the spices…"],
    [80, "Casing the Wurst…"],
    [95, "Signing the casing…"],
    [101, "Almost done…"],
  ];
  var COMIC_TEXT = ["oink oink!", "grrr grrr…", "squish squish", "oink!! 🐽", "grrrind…"];

  function statusForProgress(p) {
    for (var i = 0; i < STATUS_TEXT.length; i++) if (p < STATUS_TEXT[i][0]) return STATUS_TEXT[i][1];
    return "Almost done…";
  }
  function comicForProgress(p) {
    return COMIC_TEXT[Math.min(COMIC_TEXT.length - 1, Math.floor(p / 20))];
  }
  function formatBytes(bytes) {
    if (!bytes) return null;
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
    return (bytes / (1024 * 1024)).toFixed(1) + " MB";
  }

  function showStage(el) {
    [idle, dropped, processing, done].forEach(function (s) { s.hidden = s !== el; });
  }

  function setDroppedFile(f) {
    if (f) {
      currentFile.name = f.name || currentFile.name;
      currentFile.size = formatBytes(f.size) || currentFile.size;
      var ext = (currentFile.name.indexOf(".") > -1 ? currentFile.name.split(".").pop() : "zip").toUpperCase();
      currentFile.format = ext + (ext === "ZIP" ? " Archive" : " File");
    }
    fname.textContent = currentFile.name;
    fsize.textContent = currentFile.size;
    fformat.textContent = currentFile.format;
    fileInfo.classList.remove("poofing");
    showStage(dropped);
  }

  idle.addEventListener("dragover", function (e) { e.preventDefault(); idle.classList.add("dragover"); });
  idle.addEventListener("dragleave", function () { idle.classList.remove("dragover"); });
  idle.addEventListener("drop", function (e) {
    e.preventDefault();
    idle.classList.remove("dragover");
    var f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    setDroppedFile(f);
  });
  browseBtn.addEventListener("click", function () { fileInput.click(); });
  fileInput.addEventListener("change", function (e) {
    var f = e.target.files && e.target.files[0];
    setDroppedFile(f);
  });

  startBtn.addEventListener("click", function () {
    fileInfo.classList.add("poofing");
    setTimeout(startGrind, 380);
  });

  function startGrind() {
    showStage(processing);
    var progress = 0;
    progressFill.style.width = "0%";
    progressTimer = setInterval(function () {
      progress = Math.min(100, progress + 2);
      progressFill.style.width = progress + "%";
      statusText.textContent = statusForProgress(progress);
      comicText.textContent = comicForProgress(progress);
      if (progress >= 100) {
        clearInterval(progressTimer);
        setTimeout(function () { showStage(done); }, 350);
      }
    }, 90);
  }

  resetBtn.addEventListener("click", function () {
    if (progressTimer) clearInterval(progressTimer);
    fileInput.value = "";
    showStage(idle);
  });

  downloadBtn.addEventListener("click", function () {
    var outName = currentFile.name.replace(/\.[^./]+$/, "") + ".wurst";
    var demoContents = "This is a demo .wurst produced by the Wurster website's MeatGrinder page.\n" +
      "It's not a real binary Wurst — wire this button up to your actual MeatGrinder build output.\n\n" +
      "Source: " + currentFile.name + " (" + currentFile.size + ")\n";
    var blob = new Blob([demoContents], { type: "application/octet-stream" });
    var url = URL.createObjectURL(blob);
    var a = document.createElement("a");
    a.href = url;
    a.download = outName;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  });
})();
