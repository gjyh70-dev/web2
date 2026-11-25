"""Prepare local browser assets from the checked-in GeoJSON (Python standard library)."""
import json
from collections import defaultdict
from pathlib import Path
from math import log, pi, radians, tan

APP = Path(__file__).resolve().parent
SOURCE = APP.parent / "HangJeongDong_ver20261001.geojson"
OUTPUT = APP / "map"


def project(ring):
    points = [(round(lon * 10000), round(log(tan(pi / 4 + radians(lat) / 2)) * 1800000 / pi))
              for lon, lat, *_ in ring]
    # Remove consecutive duplicates introduced by rounding. Keep small islands intact.
    compact = [point for index, point in enumerate(points) if not index or point != points[index - 1]]
    if len(set(compact)) < 3:
        return [(lon * 10000, log(tan(pi / 4 + radians(lat) / 2)) * 1800000 / pi)
                for lon, lat, *_ in ring]
    return compact


def write(name, target, data):
    packed = json.dumps(data, ensure_ascii=False, separators=(",", ":"))
    (OUTPUT / name).write_text(f"{target}={packed};\n", encoding="utf-8")


def main():
    OUTPUT.mkdir(exist_ok=True)
    provinces = {}
    shapes = defaultdict(lambda: defaultdict(list))
    with SOURCE.open(encoding="utf-8") as source:
        for feature in json.load(source)["features"]:
            p = feature["properties"]
            province = provinces.setdefault(p["sido"], {"name": p["sidonm"], "districts": {}})
            province["districts"][p["sgg"]] = p["sggnm"]
            geometry = feature["geometry"]
            polygons = geometry["coordinates"]
            if geometry["type"] == "Polygon":
                polygons = [polygons]
            for polygon in polygons:
                shapes[p["sido"]][p["sgg"]].append([project(ring) for ring in polygon])
    write("regions.js", "window.REGION_INDEX", provinces)
    for code, districts in shapes.items():
        write(f"{code}.js", f'window.REGION_SHAPES["{code}"]', districts)


if __name__ == "__main__":
    main()
