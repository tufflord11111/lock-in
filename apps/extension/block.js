// Inside a blocked iframe, Close would close the page around it.
if (window.top !== window.self) {
  document.getElementById("close-btn").remove();
}

document.getElementById("close-btn")?.addEventListener("click", () => {
  chrome.tabs.getCurrent((tab) => {
    chrome.tabs.remove(tab.id);
  });
});
