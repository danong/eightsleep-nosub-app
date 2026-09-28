const key = document.getElementById("key");
const status = document.getElementById("status");

function generateKey() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  key.textContent = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  status.textContent = "New key generated. Copy it for the Cloudflare setup screen.";
}

document.getElementById("generate").addEventListener("click", generateKey);
document.getElementById("copy").addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(key.textContent);
    status.textContent = "Key copied.";
  } catch {
    status.textContent = "Copy failed. Select the key above and copy it manually.";
  }
});

generateKey();
