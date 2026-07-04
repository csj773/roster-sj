from __future__ import annotations

import json

import build_final_deliverables as b


CHECKPOINT_FILE = b.WORK / "pilotlog_checkpoint_rows.json"
CHECKPOINT_HEADER = ["key", "fingerprint"]
SEED_LOGBOOK_XLSX = b.WORK / "seed" / "log_filled_seed.xlsx"


def keyed(flights: list[b.Flight]) -> dict[tuple, b.Flight]:
    return {b.flight_identity(flight): flight for flight in flights}


def data_quality(flight: b.Flight) -> tuple:
    return (
        1 if flight.blk_min else 0,
        1 if flight.reg else 0,
        1 if flight.off else 0,
        1 if flight.on else 0,
        round(flight.ngt_min),
        round(flight.ifr_min),
        round(flight.pic_min),
    )


def merge_prefer_complete(*flight_groups: list[b.Flight]) -> dict[tuple, b.Flight]:
    merged: dict[tuple, b.Flight] = {}
    for flights in flight_groups:
        for flight in flights:
            key = b.flight_identity(flight)
            current = merged.get(key)
            if current is None or data_quality(flight) >= data_quality(current):
                merged[key] = flight
    return merged


def field_tuple(flight: b.Flight) -> tuple:
    return (
        flight.date,
        flight.flt,
        flight.dep,
        flight.arr,
        flight.reg,
        flight.dc,
        flight.off,
        flight.on,
        round(flight.blk_min),
        flight.takeoff,
        flight.landing,
        round(flight.act_min),
        round(flight.ngt_min),
        round(flight.ifr_min),
        flight.to_count,
        flight.ldg_count,
        flight.autoland,
        flight.toga,
        round(flight.pic_min),
        flight.remarks,
    )


def json_value(value):
    if hasattr(value, "isoformat"):
        return value.isoformat()
    return value


def checkpoint_key(flight: b.Flight) -> str:
    return json.dumps([json_value(value) for value in b.flight_identity(flight)], ensure_ascii=False, sort_keys=True)


def checkpoint_fingerprint(flight: b.Flight) -> str:
    return json.dumps([json_value(value) for value in field_tuple(flight)], ensure_ascii=False, sort_keys=True)


def checkpoint_from_flights(flights: list[b.Flight]) -> dict[str, str]:
    return {checkpoint_key(flight): checkpoint_fingerprint(flight) for flight in flights}


def read_checkpoint() -> dict[str, str]:
    if not CHECKPOINT_FILE.exists():
        return {}
    rows = json.loads(CHECKPOINT_FILE.read_text(encoding="utf-8"))
    checkpoint: dict[str, str] = {}
    for row in rows:
        if len(row) < 2 or row[0] == CHECKPOINT_HEADER[0]:
            continue
        checkpoint[str(row[0])] = str(row[1])
    return checkpoint


def write_checkpoint(flights: list[b.Flight]) -> None:
    rows = [CHECKPOINT_HEADER]
    for key, fingerprint in sorted(checkpoint_from_flights(flights).items()):
        rows.append([key, fingerprint])
    CHECKPOINT_FILE.write_text(json.dumps(rows, ensure_ascii=False), encoding="utf-8")


def read_base_flights() -> list[b.Flight]:
    authoritative_flights = (
        b.read_filled_logbook_flights(b.SYNCED_AUTHORITATIVE_XLSX)
        if b.SYNCED_AUTHORITATIVE_XLSX.exists()
        else []
    )
    previous_output_flights = b.read_previous_output_flights()
    seed_flights = b.read_filled_logbook_flights(SEED_LOGBOOK_XLSX)
    merged = merge_prefer_complete(seed_flights, previous_output_flights, authoritative_flights)

    if merged:
        print(f"SYNC_BASE_SEED_FLIGHTS {len(seed_flights)}")
        print(f"SYNC_BASE_AUTHORITATIVE_FLIGHTS {len(authoritative_flights)}")
        print(f"SYNC_BASE_PREVIOUS_OUTPUT_FLIGHTS {len(previous_output_flights)}")
        print(f"SYNC_BASE_MERGED_FLIGHTS {len(merged)}")
        return b.filter_flights_by_end_date(list(merged.values()))
    if previous_output_flights:
        print(f"SYNC_BASE_FALLBACK {b.XLSX_OUT}")
        return b.filter_flights_by_end_date(previous_output_flights)
    return []


def main() -> None:
    pilotlog_flights = b.filter_flights_by_end_date(b.read_pilotlog_export_flights())
    base_flights = read_base_flights()
    if not pilotlog_flights:
        raise SystemExit(f"No usable flights found in {b.PILOTLOG_EXPORT_XLSX}")

    pilotlog_by_key = keyed(pilotlog_flights)
    base_by_key = keyed(base_flights)
    checkpoint = read_checkpoint()
    current_checkpoint = checkpoint_from_flights(pilotlog_flights)

    if not checkpoint:
        merged_flights = base_flights or pilotlog_flights
        added = 0
        deleted = 0
        modified = 0
        print("SYNC_CHECKPOINT_INITIALIZED true")
    else:
        added_keys = set(current_checkpoint) - set(checkpoint)
        deleted_keys = set(checkpoint) - set(current_checkpoint)
        modified_keys = {
            key
            for key in set(current_checkpoint) & set(checkpoint)
            if current_checkpoint[key] != checkpoint[key]
        }

        merged_by_key = dict(base_by_key)
        pilotlog_by_checkpoint_key = {checkpoint_key(flight): flight for flight in pilotlog_flights}
        base_key_by_checkpoint_key = {
            checkpoint_key(flight): b.flight_identity(flight) for flight in base_flights
        }

        for key in deleted_keys | modified_keys:
            base_key = base_key_by_checkpoint_key.get(key)
            if base_key in merged_by_key:
                del merged_by_key[base_key]

        for key in added_keys | modified_keys:
            flight = pilotlog_by_checkpoint_key.get(key)
            if flight:
                merged_by_key[b.flight_identity(flight)] = flight

        merged_flights = list(merged_by_key.values())
        added = len(added_keys)
        deleted = len(deleted_keys)
        modified = len(modified_keys)
        print("SYNC_CHECKPOINT_INITIALIZED false")

    merged_flights.sort(key=lambda f: (f.date, f.off or b.time(0, 0), f.flt))
    totals = b.compute_totals(b.page_chunks(merged_flights))

    original_output = b.XLSX_OUT
    b.XLSX_OUT = b.SYNCED_AUTHORITATIVE_XLSX
    try:
        b.write_xlsx(merged_flights, totals)
    finally:
        b.XLSX_OUT = original_output

    write_checkpoint(pilotlog_flights)
    print(f"SYNC_ADDED {added}")
    print(f"SYNC_DELETED {deleted}")
    print(f"SYNC_MODIFIED {modified}")
    print(f"SYNC_FLIGHTS {len(merged_flights)}")
    print(f"SYNC_BASE_FLIGHTS {len(base_flights)}")
    print(f"SYNC_PILOTLOG_FLIGHTS {len(pilotlog_flights)}")
    print(f"SYNCED_AUTHORITATIVE_XLSX {b.SYNCED_AUTHORITATIVE_XLSX}")


if __name__ == "__main__":
    main()
