import test from "node:test";
import assert from "node:assert/strict";
import {arenaQueryFilters} from "../src/index.js";

test("arena API filters symbol, timeframe and expert with an optional alias",()=>{
  const url=new URL("https://example.test/api/v1/arena/positions?symbol=BTCUSDT&timeframe=1h&expert=paul_wei");
  assert.deepEqual(arenaQueryFilters(url,"s"),{
    where:["s.symbol=?","s.timeframe=?","s.expert_id=?"],
    bind:["BTCUSDT","1h","paul_wei"]
  });
  assert.deepEqual(arenaQueryFilters(url,"",false),{
    where:["symbol=?","timeframe=?"],
    bind:["BTCUSDT","1h"]
  });
});
