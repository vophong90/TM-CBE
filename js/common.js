// Đặt trạng thái active cho navbar theo data-nav ('' cho trang chủ)
window.__setActive = function (key) {
  const links = document.querySelectorAll("#topnav .nav-link");
  links.forEach(a => {
    const isActive = a.dataset.nav === key && key !== "";
    a.classList.toggle("nav-active", isActive);
  });
};

// Tiện ích nhỏ: tải JSON (nếu bạn dùng file tĩnh trong /data/*.json)
async function fetchJSON(url) {
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error(`Fetch failed: ${url}`);
  return res.json();
}
window.$utils = { fetchJSON };
