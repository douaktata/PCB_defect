"""Contrôle de bout en bout sur le vrai serveur et les trois photos PCB."""

import argparse
import json
import re
from pathlib import Path

from PIL import Image
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--url", default="http://127.0.0.1:8000")
    args = parser.parse_args()
    artifacts = ROOT / "artifacts"
    artifacts.mkdir(exist_ok=True)
    results = []
    errors = []
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(channel="msedge", headless=True)
        context = browser.new_context(viewport={"width": 1440, "height": 1100}, accept_downloads=True,
                                      color_scheme="light", device_scale_factor=1)
        page = context.new_page()
        page.on("pageerror", lambda error: errors.append(str(error)))

        def collect_response(response):
            if response.url.endswith("/api/predict"):
                assert response.status == 200, response.text()
                results.append(response.json())

        page.on("response", collect_response)
        page.goto(args.url, wait_until="networkidle")
        page.wait_for_selector("#model-status.ready", timeout=120000)
        page.screenshot(path=str(artifacts / "inspection-desktop.png"), full_page=True, animations="disabled")
        examples = sorted((ROOT / "static/examples").glob("*.jpg"))
        assert len(examples) == 3
        page.locator("#file-input").set_input_files([str(path) for path in examples])
        page.wait_for_function("document.querySelectorAll('.queue-item').length === 3")
        page.wait_for_function("!document.querySelector('#analyze-button').disabled")
        page.locator("#analyze-button").click()
        page.wait_for_function("document.querySelector('#progress-label').textContent === 'Analyse terminée'", timeout=240000)
        assert len(results) == 3, results
        assert all(result["total"] > 0 for result in results)
        assert all(result["imgsz"] == 1280 for result in results)
        for result in results:
            for detection in result["detections"]:
                box = detection["bbox"]
                assert 0 <= box["x1"] < box["x2"] <= result["width"]
                assert 0 <= box["y1"] < box["y2"] <= result["height"]
        assert any(d["bbox"]["x1"] > 1280 or d["bbox"]["y1"] > 1280 for r in results for d in r["detections"])
        page.locator("[data-select]").first.click()
        first = results[0]
        assert page.locator("#detections-body tr[data-id]").count() == first["total"]
        page.locator("#zoom-fit").click()
        page.screenshot(path=str(artifacts / "inspection-result.png"), full_page=True, animations="disabled")
        page.locator("#inspection-canvas").screenshot(path=str(artifacts / "canvas.png"))
        # Contrôle des pixels du canvas à l'emplacement prédit dans l'image originale.
        canvas_box = page.locator("#inspection-canvas").bounding_box()
        scale = min((canvas_box["width"] - 32) / first["width"], (canvas_box["height"] - 32) / first["height"])
        offset_x = (canvas_box["width"] - first["width"] * scale) / 2
        offset_y = (canvas_box["height"] - first["height"] * scale) / 2
        b = first["detections"][0]["bbox"]
        px = round(offset_x + b["x1"] * scale)
        py = round(offset_y + (b["y1"] + b["y2"]) / 2 * scale)
        colors = [(224, 103, 60), (168, 120, 232), (209, 69, 101), (221, 156, 28), (41, 149, 208), (37, 165, 140)]
        target = colors[first["detections"][0]["class_id"]]
        with Image.open(artifacts / "canvas.png") as canvas_image:
            assert any(sum(abs(a - b) for a, b in zip(canvas_image.convert("RGB").getpixel((px + dx, py + dy)), target)) < 100
                       for dx in range(-2, 3) for dy in range(-2, 3)), "Boîte absente à sa position attendue sur le canvas"
        # Le deuxième exemple dépasse 1280 px : même contrôle visuel sans rescaling des résultats.
        page.locator("[data-select]").nth(1).click()
        page.locator("#zoom-fit").click()
        large = results[1]
        assert large["width"] > 1280
        page.screenshot(path=str(artifacts / "inspection-original-resolution.png"), full_page=True, animations="disabled")
        page.locator("#inspection-canvas").screenshot(path=str(artifacts / "canvas-large.png"))
        scale_large = min((canvas_box["width"] - 32) / large["width"], (canvas_box["height"] - 32) / large["height"])
        offset_x_large = (canvas_box["width"] - large["width"] * scale_large) / 2
        offset_y_large = (canvas_box["height"] - large["height"] * scale_large) / 2
        b_large = next(d for d in large["detections"] if d["bbox"]["x1"] > 1280 or d["bbox"]["y1"] > 1280)
        box_large = b_large["bbox"]
        lx = round(offset_x_large + box_large["x1"] * scale_large)
        ly = round(offset_y_large + (box_large["y1"] + box_large["y2"]) / 2 * scale_large)
        target_large = colors[b_large["class_id"]]
        with Image.open(artifacts / "canvas-large.png") as canvas_large:
            rgb = canvas_large.convert("RGB")
            assert any(sum(abs(a - b) for a, b in zip(rgb.getpixel((lx + dx, ly + dy)), target_large)) < 100
                       for dx in range(-2, 3) for dy in range(-2, 3)), "Boîte mal positionnée sur l'image > 1280 px"
        page.locator("[data-select]").first.click()
        page.locator("#detections-body tr[data-id]").first.hover()
        assert "hovered" in page.locator("#detections-body tr[data-id]").first.get_attribute("class")
        legend = page.locator("[data-class]").first
        legend.click()
        assert legend.get_attribute("aria-pressed") == "false"
        legend.click()
        before_zoom = page.locator("#zoom-label").inner_text()
        page.locator("#zoom-in").click()
        assert page.locator("#zoom-label").inner_text() != before_zoom
        page.locator("#zoom-fit").click()
        page.locator("[data-sort='class_name']").click()
        assert page.locator("[data-sort='class_name']").locator("..").get_attribute("aria-sort") == "ascending"
        for format in ["png", "json", "csv", "report"]:
            with page.expect_download() as download_info:
                page.locator(f"[data-export='{format}']").click()
            download = download_info.value
            download.save_as(artifacts / download.suggested_filename)
            assert (artifacts / download.suggested_filename).stat().st_size > 100
            if format == "json":
                assert json.loads((artifacts / download.suggested_filename).read_text(encoding="utf-8")) == first
            if format == "png":
                with Image.open(artifacts / download.suggested_filename) as annotated:
                    assert annotated.size == (first["width"], first["height"])
        report_path = next(artifacts.glob("*_rapport.html"))
        report_page = context.new_page()
        report_page.goto(report_path.as_uri())
        assert report_page.locator(".page").count() == 1
        report_page.pdf(path=str(artifacts / "rapport.pdf"), prefer_css_page_size=True)
        assert len(re.findall(rb"/Type /Page\b", (artifacts / "rapport.pdf").read_bytes())) == 1
        report_page.close()
        page.locator("[data-view='history']").click()
        assert page.locator(".history-card").count() == 3
        page.locator(".history-card").last.click()
        page.wait_for_selector("#view-inspection", state="visible")
        page.locator("[data-view='about']").click()
        assert page.locator("#model-metrics-body tr").count() == 6
        assert "0,61" in page.locator("#model-metrics-body").inner_text()
        page.locator("[data-view='inspection']").click()
        page.locator("#theme-toggle").click()
        assert page.locator("html").get_attribute("data-theme") == "dark"
        page.screenshot(path=str(artifacts / "inspection-dark.png"), full_page=True, animations="disabled")
        page.set_viewport_size({"width": 390, "height": 844})
        page.locator("#inspection-canvas").scroll_into_view_if_needed()
        page.screenshot(path=str(artifacts / "inspection-mobile-result.png"), full_page=True, animations="disabled")
        assert page.evaluate("document.documentElement.scrollWidth <= window.innerWidth")
        page.reload(wait_until="networkidle")
        assert page.locator("html").get_attribute("data-theme") == "dark"
        page.locator("#theme-toggle").click()
        page.set_viewport_size({"width": 390, "height": 844})
        page.screenshot(path=str(artifacts / "inspection-mobile.png"), full_page=True, animations="disabled")
        assert page.evaluate("document.documentElement.scrollWidth <= window.innerWidth"), "Débordement horizontal sur mobile"
        # Aucun service distant requis par la page.
        assert not page.evaluate("performance.getEntriesByType('resource').some(r => r.name.startsWith('http') && !r.name.startsWith(location.origin))")
        assert not errors, errors
        context.close()
        browser.close()
    (artifacts / "validation.json").write_text(json.dumps({"results": results, "browser_errors": errors,
                                                          "canvas_coordinates_verified": True}, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({"status": "ok", "images": [{"file": r["filename"], "dimensions": [r["width"], r["height"]],
                                                  "defects": r["total"], "inference_ms": r["inference_ms"]} for r in results],
                      "artifacts": str(artifacts)}, ensure_ascii=False))


if __name__ == "__main__":
    main()
