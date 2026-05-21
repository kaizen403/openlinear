import { httpServerHandler } from "cloudflare:node";
import { createApp } from "./app";

const app = createApp();
app.listen(3000);

export default httpServerHandler({ port: 3000 });
