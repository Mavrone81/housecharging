import 'dotenv/config';
import { createApp } from './app.js';

const port = process.env.PORT || 3000;
const app = createApp();
app.listen(port, () => {
  console.log(`MCTS billing server listening on :${port}`);
});
