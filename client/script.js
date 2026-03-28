async function test() {
  console.log("1");
  const ws = new WebSocket("ws://localhost:3000/ws");
  console.log("2");
  await new Promise((resolve, reject) => {
    console.log("3");
    ws.addEventListener("open", () => {
      console.log("4");
      ws.send("test");
    });
    console.log("5");

    ws.addEventListener("message", (event) => {
      console.log("6");
      console.log(event.data);
      ws.close();
    });
    console.log("7");

    ws.addEventListener("close", () => {
      console.log("8");

      resolve();
    });
    console.log("9");

    ws.addEventListener("error", () => {
      console.log("10");

      reject(new Error("WebSocket connection failed"));
    });
  });
  console.log("11");
}
console.log("12");

test();
console.log("3");
