"""Read the published Share of GDP sheet without requiring spreadsheet packages."""
import io
import json
import posixpath
import re
import sys
import zipfile
from decimal import Decimal
from xml.etree import ElementTree as ET

NS = {"s": "http://schemas.openxmlformats.org/spreadsheetml/2006/main"}
REL = "{http://schemas.openxmlformats.org/officeDocument/2006/relationships}id"
COUNTRIES = {
    "Belarus": "Białoruś", "Czechia": "Czechy", "Czech Republic": "Czechy",
    "Germany": "Niemcy", "Lithuania": "Litwa", "Poland": "Polska",
    "Russia": "Rosja", "Slovakia": "Słowacja", "Ukraine": "Ukraina",
}

with zipfile.ZipFile(io.BytesIO(sys.stdin.buffer.read())) as workbook:
    sheets = ET.fromstring(workbook.read("xl/workbook.xml"))
    sheet = next(s for s in sheets.findall(".//s:sheet", NS) if s.get("name") == "Share of GDP")
    links = ET.fromstring(workbook.read("xl/_rels/workbook.xml.rels"))
    target = next(link.attrib["Target"] for link in links if link.get("Id") == sheet.attrib[REL])
    sheet_path = target.lstrip("/") if target.startswith("/") else posixpath.join("xl", target)
    root = ET.fromstring(workbook.read(sheet_path))
    shared = ET.fromstring(workbook.read("xl/sharedStrings.xml"))
    strings = ["".join(t.text or "" for t in item.findall(".//s:t", NS)) for item in shared]

headers = {}
records = []
for row in root.findall(".//s:row", NS):
    values = {}
    for cell in row.findall("s:c", NS):
        raw = cell.findtext("s:v", "", NS)
        values[re.match("[A-Z]+", cell.attrib["r"]).group()] = strings[int(raw)] if raw and cell.get("t") == "s" else raw
    name = values.get("A")
    if name == "Country":
        years = {col: int(v) for col, v in values.items() if re.fullmatch("[0-9]{4}", v)}
        last = max(years.values())
        headers = {col: year for col, year in years.items() if year >= last - 2}
    if name not in COUNTRIES:
        continue
    for col, year in headers.items():
        value = values.get(col, "")
        if not re.fullmatch(r"[0-9]+(?:\.[0-9]+)?(?:[Ee][+-]?[0-9]+)?", value):
            continue
        percent = Decimal(value) * 100
        records.append({"country": COUNTRIES[name], "year": str(year), "percent": format(percent, ".5f").replace(".", ",")})

if not records or len(headers) != 3:
    raise ValueError("Missing country rows or recent year columns in Share of GDP")
json.dump(records, sys.stdout, ensure_ascii=False)
