const r = await fetch("https://welplus.welstory.com/login", {
  method: "POST",
  headers: {
    "User-Agent": "Welplus",
    "X-Device-Id": crypto.randomUUID(),
    "X-Autologin": "N",
    "Content-Type": "application/x-www-form-urlencoded",
  },
  body: new URLSearchParams({ username: "test", password: "test", "remember-me": "false" }),
});
console.log(r.status, r.headers.get("x-iinfo"));
console.log((await r.text()).slice(0, 200));