import { test, expect, Page } from "@playwright/test";

function assertNativeSmokeLayout(main: HTMLElement | null, tab: Element): void {
  if (!main || !tab.isConnected || !tab.classList.contains("selected"))
    throw new Error("Navigation failed");

  const bounds = main.getBoundingClientRect();
  const style = getComputedStyle(main);
  const borderLeft = parseFloat(style.borderLeftWidth);
  const borderRight = parseFloat(style.borderRightWidth);
  const gutter = Math.max(
    0,
    main.offsetWidth - main.clientWidth - borderLeft - borderRight,
  );
  const left = bounds.left + borderLeft;
  const right = bounds.right - borderRight - gutter;
  for (const child of main.querySelectorAll("*")) {
    if (
      !child.getClientRects().length ||
      getComputedStyle(child).visibility !== "visible"
    )
      continue;
    const childBounds = child.getBoundingClientRect();
    if (childBounds.left < left || childBounds.right > right)
      throw new Error("Visible settings content exceeds its viewport");
  }

  const overflow = main.scrollWidth - main.clientWidth;
  // WebKit can round integer metrics differently at fractional zoom.
  const fractionalRounding =
    overflow === 1 &&
    !Number.isInteger(bounds.width) &&
    document.documentElement.clientWidth - innerWidth === 1;
  if (overflow > 0 && !fractionalRounding)
    throw new Error("Settings layout overflows horizontally");
}

test.use({ deviceScaleFactor: 1.25 });

async function fixture(page: Page) {
  await page.setContent(`<style>
    body { margin: 0; }
    main { position: relative; width: 200.5px; height: 80px; overflow: hidden; }
    #content { width: 100px; height: 20px; }
  </style><button class="selected">General</button><main><div id="content"></div></main>`);
  await page.addScriptTag({
    content: `window.assertNativeSmokeLayout = ${assertNativeSmokeLayout.toString()};`,
  });
}

async function rounding(
  page: Page,
  overflow = 1,
  rootDifference = 1,
  dpr = 1.25,
) {
  await page.evaluate(
    ({ overflow, rootDifference, dpr }) => {
      const main = document.querySelector("main")!;
      Object.defineProperty(main, "scrollWidth", {
        configurable: true,
        get: () => main.clientWidth + overflow,
      });
      Object.defineProperty(document.documentElement, "clientWidth", {
        configurable: true,
        get: () => innerWidth + rootDifference,
      });
      Object.defineProperty(window, "devicePixelRatio", {
        configurable: true,
        get: () => dpr,
      });
    },
    { overflow, rootDifference, dpr },
  );
}

async function result(page: Page) {
  return page.evaluate(() => {
    try {
      (window as any).assertNativeSmokeLayout(
        document.querySelector("main"),
        document.querySelector("button"),
      );
      return "PASS";
    } catch (error) {
      return String(error);
    }
  });
}

test("native layout accepts contained content and the measured fractional WebKit mismatch", async ({
  page,
}) => {
  await fixture(page);
  expect(await result(page)).toBe("PASS");
  await rounding(page);
  expect(await result(page)).toBe("PASS");
});

test("native layout accepts the packaged WebKit rounding geometry with integer device pixel ratio", async ({
  page,
}) => {
  await fixture(page);
  await rounding(page, 1, 1, 1);
  expect(await result(page)).toBe("PASS");
});

for (const pixels of [1, 2, 24]) {
  test(`native layout rejects actual ${pixels}px visible overflow despite fractional getter mismatch`, async ({
    page,
  }) => {
    await fixture(page);
    await rounding(page);
    const measured = await page.evaluate((pixels) => {
      const main = document.querySelector("main")!;
      const child = document.querySelector<HTMLElement>("#content")!;
      child.style.cssText = `position:absolute;left:100%;width:${pixels}px;height:20px`;
      return (
        child.getBoundingClientRect().right - main.getBoundingClientRect().right
      );
    }, pixels);
    expect(measured).toBe(pixels);
    expect(await result(page)).toContain(
      "Visible settings content exceeds its viewport",
    );
  });
}

test("native layout requires visible bounds even when integer getters report no overflow", async ({
  page,
}) => {
  await fixture(page);
  await rounding(page, 0);
  await page.evaluate(() => {
    document.querySelector<HTMLElement>("#content")!.style.cssText =
      "position:absolute;left:-1px;width:1px;height:20px";
  });
  expect(await result(page)).toContain(
    "Visible settings content exceeds its viewport",
  );
});

test("native layout rejects unmatched rounding conditions and larger metric differences", async ({
  page,
}) => {
  await fixture(page);
  for (const [overflow, rootDifference, dpr] of [
    [1, 0, 1.25],
    [1, -1, 1.25],
    [1, 2, 1],
    [2, 1, 1.25],
  ]) {
    await rounding(page, overflow, rootDifference, dpr);
    expect(await result(page)).toContain(
      "Settings layout overflows horizontally",
    );
  }
  await rounding(page);
  await page.evaluate(() => {
    document.querySelector<HTMLElement>("main")!.style.width = "200px";
  });
  expect(await result(page)).toContain(
    "Settings layout overflows horizontally",
  );
});

test("native layout always requires selected and connected navigation", async ({
  page,
}) => {
  await fixture(page);
  await rounding(page);
  await page.evaluate(() =>
    document.querySelector("button")!.classList.remove("selected"),
  );
  expect(await result(page)).toContain("Navigation failed");
  const detached = await page.evaluate(() => {
    const tab = document.querySelector("button")!;
    tab.classList.add("selected");
    tab.remove();
    try {
      (window as any).assertNativeSmokeLayout(
        document.querySelector("main"),
        tab,
      );
      return "PASS";
    } catch (error) {
      return String(error);
    }
  });
  expect(detached).toContain("Navigation failed");
});
