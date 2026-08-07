#!/usr/bin/env python3
"""Generate small, public-safe AnyDoc semantic-conformance fixtures."""

from __future__ import annotations

import csv
from io import BytesIO
from pathlib import Path

from docx import Document
from openpyxl import Workbook
from PIL import Image, ImageDraw
from pptx import Presentation
from pptx.util import Inches
from reportlab.lib.utils import ImageReader
from reportlab.pdfgen import canvas

ROOT = Path(__file__).resolve().parent
GENERATED = ROOT / "generated"


def write_csv() -> None:
    path = GENERATED / "baseline.csv"
    with path.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.writer(handle)
        writer.writerow(["name", "value"])
        writer.writerow(["alpha", 1])
        writer.writerow(["beta", 2])


def write_xlsx() -> None:
    workbook = Workbook()
    sheet = workbook.active
    sheet.title = "Data Sheet"

    sheet["A1"] = "Visible row"
    sheet["A2"] = "Hidden row"
    sheet.row_dimensions[2].hidden = True

    sheet["B1"] = "Hidden column"
    sheet.column_dimensions["B"].hidden = True

    sheet["C1"] = "Displayed percent"
    sheet["C2"] = 0.075
    sheet["C2"].number_format = "0.0%"

    sheet["D1"] = "Formula"
    sheet["D2"] = "=C2"

    sheet.merge_cells("F1:O3")
    sheet["F1"] = "Merged heading"

    workbook.save(GENERATED / "semantic-risks.xlsx")


def write_docx() -> None:
    document = Document()
    document.add_heading("Nested table evidence", level=1)
    outer = document.add_table(rows=1, cols=1)
    cell = outer.cell(0, 0)
    cell.paragraphs[0].add_run("Section A")
    inner = cell.add_table(rows=3, cols=2)
    inner.cell(0, 0).text = "Metric"
    inner.cell(0, 1).text = "Value"
    inner.cell(1, 0).text = "Height"
    inner.cell(1, 1).text = "120"
    inner.cell(2, 0).text = "Weight"
    inner.cell(2, 1).text = "34"
    document.save(GENERATED / "nested-table.docx")


def add_textbox(slide, text: str) -> None:
    box = slide.shapes.add_textbox(Inches(1), Inches(1), Inches(8), Inches(2))
    box.text_frame.text = text


def write_pptx() -> None:
    presentation = Presentation()
    first = presentation.slides.add_slide(presentation.slide_layouts[5])
    first.shapes.title.text = "Titled slide"

    second = presentation.slides.add_slide(presentation.slide_layouts[6])
    add_textbox(second, "Second slide, no title placeholder.")

    third = presentation.slides.add_slide(presentation.slide_layouts[6])
    add_textbox(third, "Third slide, also untitled.")

    presentation.save(GENERATED / "untitled-slides.pptx")


def write_image_only_pdf() -> None:
    image = Image.new("RGB", (300, 120), "white")
    draw = ImageDraw.Draw(image)
    draw.rectangle((20, 20, 280, 100), outline="black", width=3)
    draw.text((40, 50), "pixels only", fill="black")

    png = BytesIO()
    image.save(png, format="PNG")
    png.seek(0)

    path = GENERATED / "image-only.pdf"
    pdf = canvas.Canvas(str(path), pagesize=(360, 180))
    pdf.drawImage(ImageReader(png), 30, 30, width=300, height=120)
    pdf.showPage()
    pdf.save()


def main() -> None:
    GENERATED.mkdir(parents=True, exist_ok=True)
    write_csv()
    write_xlsx()
    write_docx()
    write_pptx()
    write_image_only_pdf()
    for path in sorted(GENERATED.iterdir()):
        print(f"generated {path.name} ({path.stat().st_size} bytes)")


if __name__ == "__main__":
    main()
