// 高德天气接口要求传入城市的 adcode，而用户更习惯输入城市名称。
// 这里把教程允许查询的四个城市提前映射好，避免把接口细节交给模型猜。
const cityCodes = {
    北京: "110000",
    上海: "310000",
    广州: "440100",
    深圳: "440300",
};

// weatherTool 是发给模型看的“工具说明书”。
// 模型会根据 description 判断什么时候使用它，再按照 parameters 生成参数。
export const weatherTool = {
    type: "function",
    name: "get_weather",
    description: "查询北京、上海、广州或深圳的实时天气",
    parameters: {
        type: "object",
        properties: {
            city: {
                type: "string",
                enum: Object.keys(cityCodes),
                description: "要查询的城市名称",
            },
        },
        required: ["city"],
        additionalProperties: false,
    },
    // strict: true 要求模型严格按照上面的 JSON Schema 生成参数。
    strict: true,
};

// getWeather 是应用真正执行的 JavaScript 函数。
// 模型无法直接访问网络，只能请求我们的程序调用这个函数。
export async function getWeather({ city }) {
    const cityCode = cityCodes[city];

    // 即使工具 Schema 已限制城市，函数本身仍然要做边界检查。
    // 不能把所有安全责任都交给模型。
    if (!cityCode) {
        throw new Error("目前只支持查询北京、上海、广州和深圳");
    }

    // Key 只从环境变量读取，不能直接写进源码。
    if (!process.env.AMAP_API_KEY) {
        throw new Error("请先在 .env 中配置 AMAP_API_KEY");
    }

    // URL 和 URLSearchParams 会负责正确编码查询参数。
    const url = new URL("https://restapi.amap.com/v3/weather/weatherInfo");
    url.search = new URLSearchParams({
        key: process.env.AMAP_API_KEY,
        city: cityCode,
        extensions: "base",
        output: "JSON",
    });

    // fetch 负责向高德天气接口发送 HTTP GET 请求。
    const response = await fetch(url);

    // HTTP 状态码不是 2xx 时，先作为网络请求错误处理。
    if (!response.ok) {
        throw new Error(`天气接口请求失败：HTTP ${response.status}`);
    }

    const data = await response.json();

    // 高德即使返回 HTTP 200，也可能在 JSON 中报告业务错误。
    if (data.status !== "1") {
        throw new Error(data.info || "天气接口返回错误");
    }

    // lives[0] 是当前天气；如果数据结构异常，就返回原始数据方便排查。
    return data.lives?.[0] ?? data;
}
