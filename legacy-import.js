if (location.protocol === "https:") {
  document.querySelector("#send-legacy").disabled = true;
  document.querySelector("#legacy-message").textContent =
    "浏览器自动升级到了 HTTPS，无法读取旧 HTTP 来源的记录。" +
    "原始记录没有丢失；请联系管理员协助导出。不要在此页面输入密码。";
}

document.querySelector("#send-legacy").addEventListener("click", () => {
  const message = document.querySelector("#legacy-message");
  const nonce = new URLSearchParams(location.search).get("nonce");
  if (!window.opener || !/^[a-f0-9-]{36}$/.test(nonce || "")) {
    message.textContent = "请从 HTTPS 网站的个人资料中打开此页面。";
    return;
  }
  try {
    const state = JSON.parse(localStorage.getItem("shiguang.daily-study.v1"));
    let prefs = {};
    try {
      prefs = JSON.parse(
        localStorage.getItem("shiguang.daily-study.prefs.v1"),
      ) || {};
    } catch { /* 偏好损坏时使用默认值，保留原始数据。 */ }
    window.opener.postMessage(
      { type: "legacy-study", nonce, state, prefs },
      `https://${location.host}`,
    );
    message.textContent = "已发送，请返回 HTTPS 页面确认导入。";
  } catch {
    message.textContent = "旧记录无法读取，原始数据未被修改。";
  }
});
