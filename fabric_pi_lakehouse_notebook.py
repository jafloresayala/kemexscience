# ==========================================================
# Notebook Microsoft Fabric - PI Web API -> Lakehouse Delta
# Versión corregida con endpoints reales
# ==========================================================

import urllib3
import requests
import pandas as pd
from datetime import datetime, timedelta
from typing import Any
from delta.tables import DeltaTable
from pyspark.sql import functions as F

# =========================================================
# PI WEB API - valores reales proporcionados
# =========================================================
BASE_URL = "https://kp.kemx.keint.com/PI_WebApi/api/Generic"
ENDPOINT_CHILDREN = f"{BASE_URL}/Fetch_Child_Elements"
ENDPOINT_ATTRIBUTES = f"{BASE_URL}/Fetch_Element_Attributes"
ENDPOINT_TAG_VALUES = f"{BASE_URL}/Fetch_Generic_Tag_Class_with_PluginName"

PLUGIN_NAME = "MBBP Data Fetch"
ROOT_PATH = r"\\NTS5120\Kimball BD Produccion\Kimball Electronics Mexico\Production\SMT\Plant 2"

VERIFY_SSL = False
API_TIMEOUT = 30

LOAD_MODE = "manual"  # "manual" o "incremental"
LOOKBACK_HOURS = 24
FROM_DT = datetime(2026, 5, 5, 0, 0, 0)
TO_DT = datetime(2026, 5, 5, 23, 59, 59)

TAG_NAMES = [
    "TAG_001",
    "TAG_002",
]

ELEMENT_PATHS = [ROOT_PATH]

TBL_CHILDREN = "pi_children"
TBL_ATTRIBUTES = "pi_attributes"
TBL_VALUES_BRONZE = "pi_tag_values_bronze"
TBL_VALUES_SILVER = "pi_tag_values_silver"
TBL_SUMMARY_HOURLY = "pi_tag_summary_hourly"
TBL_SUMMARY_DAILY = "pi_tag_summary_daily"

SHIFT_1_START = 6
SHIFT_2_START = 14
SHIFT_3_START = 22


def _post(url: str, payload: dict) -> dict | list:
    headers = {"Accept": "application/json", "Content-Type": "application/json"}
    if not VERIFY_SSL:
        urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)
    resp = requests.post(url, headers=headers, json=payload, timeout=API_TIMEOUT, verify=VERIFY_SSL)
    resp.raise_for_status()
    return resp.json()


def _format_dt(dt: datetime) -> str:
    return dt.strftime("%Y%m%d%H%M%S")


def fetch_children(element_path: str) -> pd.DataFrame:
    data = _post(ENDPOINT_CHILDREN, {"Plugin_Name": PLUGIN_NAME, "Element_Path": element_path})
    if isinstance(data, dict): data = [data]
    if not isinstance(data, list): return pd.DataFrame()
    df = pd.DataFrame(data)
    for col in ("id", "name", "path", "type", "template", "description"):
        if col not in df.columns: df[col] = None
    df = df[["id", "name", "path", "type", "template", "description"]]
    df["Element_Path_Query"] = element_path
    df["Load_Date"] = datetime.now()
    return df


def fetch_attributes(element_path: str) -> pd.DataFrame:
    data = _post(ENDPOINT_ATTRIBUTES, {"Plugin_Name": PLUGIN_NAME, "Element_Path": element_path})
    if isinstance(data, dict): data = [data]
    if not isinstance(data, list): return pd.DataFrame()
    df = pd.DataFrame(data)
    expected = ["id", "name", "path", "type", "description", "value", "lastValueDate", "configuration_string", "categories", "UOM", "hasChildren", "isExcluded", "piPoint"]
    for col in expected:
        if col not in df.columns: df[col] = None
    df = df[expected]
    df["Element_Path_Query"] = element_path
    df["Load_Date"] = datetime.now()
    return df


def fetch_tag_values(tag_names: list[str], from_dt: datetime, to_dt: datetime) -> pd.DataFrame:
    payload = {"Plugin_Name": PLUGIN_NAME, "From_Date": _format_dt(from_dt), "To_Date": _format_dt(to_dt), "Tag_Names": tag_names}
    data = _post(ENDPOINT_TAG_VALUES, payload)
    if isinstance(data, dict): data = [data]
    if not isinstance(data, list): return pd.DataFrame()
    records = []
    for tag_obj in data:
        for point in tag_obj.get("Tag_Values", []) or []:
            raw = point.get("Value")
            records.append({
                "Tag_Name": tag_obj.get("Tag_Name"),
                "Tag_Type": tag_obj.get("Tag_Type"),
                "Result": tag_obj.get("Result"),
                "ErrorMsg": tag_obj.get("ErrorMsg"),
                "Value_Raw": raw,
                "Value_Str": "" if raw is None else str(raw),
                "TimeStamp_Raw": point.get("TimeStamp"),
                "From_Date_Query": from_dt,
                "To_Date_Query": to_dt,
                "Load_Date": datetime.now(),
            })
    return pd.DataFrame(records)


def parse_pi_timestamp_preserve_local(ts_series: pd.Series) -> pd.Series:
    s = ts_series.astype("string")
    s = s.str.replace(r"(Z|[+-]\d{2}:\d{2})$", "", regex=True)
    return pd.to_datetime(s, errors="coerce")


def get_shift(hour: Any) -> str | None:
    if pd.isna(hour): return None
    hour = int(hour)
    if SHIFT_1_START <= hour < SHIFT_2_START: return "Turno 1"
    if SHIFT_2_START <= hour < SHIFT_3_START: return "Turno 2"
    return "Turno 3"


def clean_values_silver(df: pd.DataFrame) -> pd.DataFrame:
    if df.empty: return pd.DataFrame()
    out = df.copy()
    out["TimeStamp"] = parse_pi_timestamp_preserve_local(out["TimeStamp_Raw"])
    out["Value_Num"] = pd.to_numeric(out["Value_Raw"], errors="coerce")
    out["Date"] = out["TimeStamp"].dt.date
    out["Year"] = out["TimeStamp"].dt.year.astype("Int64")
    out["Month"] = out["TimeStamp"].dt.month.astype("Int64")
    out["Day"] = out["TimeStamp"].dt.day.astype("Int64")
    out["Hour"] = out["TimeStamp"].dt.hour.astype("Int64")
    out["Minute"] = out["TimeStamp"].dt.minute.astype("Int64")
    out["Shift"] = out["Hour"].apply(get_shift)
    out["Record_Key"] = out["Tag_Name"].fillna("").astype(str) + "|" + out["TimeStamp_Raw"].fillna("").astype(str) + "|" + out["Value_Str"].fillna("").astype(str)
    return out


def build_hourly_summary(df: pd.DataFrame) -> pd.DataFrame:
    if df.empty: return pd.DataFrame()
    work = df.dropna(subset=["Value_Num", "TimeStamp"]).copy()
    if work.empty: return pd.DataFrame()
    out = work.groupby(["Tag_Name", "Date", "Year", "Month", "Day", "Hour", "Shift"], as_index=False).agg(
        Avg_Value=("Value_Num", "mean"), Min_Value=("Value_Num", "min"), Max_Value=("Value_Num", "max"), Std_Value=("Value_Num", "std"), Count_Readings=("Value_Num", "count"), First_Timestamp=("TimeStamp", "min"), Last_Timestamp=("TimeStamp", "max")
    )
    out["Load_Date"] = datetime.now()
    out["Summary_Key"] = out["Tag_Name"].astype(str) + "|" + out["Date"].astype(str) + "|" + out["Hour"].astype(str)
    return out


def build_daily_summary(df: pd.DataFrame) -> pd.DataFrame:
    if df.empty: return pd.DataFrame()
    work = df.dropna(subset=["Value_Num", "TimeStamp"]).copy()
    if work.empty: return pd.DataFrame()
    out = work.groupby(["Tag_Name", "Date", "Year", "Month", "Day"], as_index=False).agg(
        Avg_Value=("Value_Num", "mean"), Min_Value=("Value_Num", "min"), Max_Value=("Value_Num", "max"), Std_Value=("Value_Num", "std"), Count_Readings=("Value_Num", "count"), First_Timestamp=("TimeStamp", "min"), Last_Timestamp=("TimeStamp", "max")
    )
    out["Load_Date"] = datetime.now()
    out["Summary_Key"] = out["Tag_Name"].astype(str) + "|" + out["Date"].astype(str)
    return out


def table_exists(table_name: str) -> bool:
    return spark.catalog.tableExists(table_name)


def pandas_to_spark(df: pd.DataFrame):
    if df is None or df.empty: return None
    return spark.createDataFrame(df)


def append_delta_table(df: pd.DataFrame, table_name: str) -> None:
    sdf = pandas_to_spark(df)
    if sdf is None:
        print(f"[WARN] {table_name}: vacío")
        return
    sdf.write.mode("append").format("delta").option("mergeSchema", "true").saveAsTable(table_name)
    print(f"[OK] append {table_name}: {df.shape[0]} filas")


def merge_delta_table(df: pd.DataFrame, table_name: str, key_col: str) -> None:
    sdf = pandas_to_spark(df)
    if sdf is None:
        print(f"[WARN] {table_name}: vacío")
        return
    if not table_exists(table_name):
        sdf.write.mode("overwrite").format("delta").option("overwriteSchema", "true").saveAsTable(table_name)
        print(f"[OK] creada {table_name}: {df.shape[0]} filas")
        return
    DeltaTable.forName(spark, table_name).alias("t").merge(sdf.alias("s"), f"t.{key_col} = s.{key_col}").whenMatchedUpdateAll().whenNotMatchedInsertAll().execute()
    print(f"[OK] merge {table_name}: {df.shape[0]} filas fuente")

# Ejecución
if LOAD_MODE.lower() == "incremental":
    to_dt = datetime.now()
    from_dt = to_dt - timedelta(hours=LOOKBACK_HOURS)
else:
    from_dt = FROM_DT
    to_dt = TO_DT

print(f"Rango: {from_dt} -> {to_dt}")

children_frames = []
attributes_frames = []
for path in ELEMENT_PATHS:
    children_frames.append(fetch_children(path))
    attributes_frames.append(fetch_attributes(path))

if children_frames:
    df_children = pd.concat(children_frames, ignore_index=True)
    merge_delta_table(df_children, TBL_CHILDREN, "id")
if attributes_frames:
    df_attributes = pd.concat(attributes_frames, ignore_index=True)
    merge_delta_table(df_attributes, TBL_ATTRIBUTES, "id")

df_bronze = fetch_tag_values(TAG_NAMES, from_dt, to_dt)
append_delta_table(df_bronze, TBL_VALUES_BRONZE)

df_silver = clean_values_silver(df_bronze)
merge_delta_table(df_silver, TBL_VALUES_SILVER, "Record_Key")

df_hourly = build_hourly_summary(df_silver)
merge_delta_table(df_hourly, TBL_SUMMARY_HOURLY, "Summary_Key")

df_daily = build_daily_summary(df_silver)
merge_delta_table(df_daily, TBL_SUMMARY_DAILY, "Summary_Key")

spark.sql("SHOW TABLES").show(truncate=False)
