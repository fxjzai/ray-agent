import assert from "node:assert/strict";
import test from "node:test";
import { add } from "../src/math.js";

test("add 返回两个数字之和", () => {
    assert.equal(add(2, 3), 5);
});
