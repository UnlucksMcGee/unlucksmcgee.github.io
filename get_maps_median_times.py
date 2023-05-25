import datetime
import time
import urllib.parse
import html
import os
from urllib.request import urlopen
import sqlite3
import sys
import json

if len(sys.argv) < 2:
    print("Please pass the path to the sqlite db")
    sys.exit()

db_path = sys.argv[1]
if not os.path.exists(db_path):
    print("db path doesn't exist")
    sys.exit()

con = sqlite3.connect(db_path)
cur = con.cursor()
cur.execute("SELECT Map FROM maps ORDER BY Map ASC")

rows = cur.fetchall()
all_map_names = []
for row in rows:
    all_map_names.append(row[0])

print(len(all_map_names))

if os.path.exists("all_map_json_data.json"):
    with open("all_map_json_data.json") as f:
        all_map_json_data = json.load(f)
else:
    all_map_json_data = {}

url = "https://ddnet.org/maps/?json="
for i, map_name in enumerate(all_map_names):
    print(i+1 , len(all_map_names))

    # Skip map name if it already has been fetched and if more than 90 days old
    if map_name in all_map_json_data:
        try:
            if all_map_json_data[map_name]["release"] is None:
                continue
            elif datetime.datetime.fromtimestamp(all_map_json_data[map_name]["release"]) < (datetime.datetime.now() - datetime.timedelta(days=90)):
                continue
            else:
                pass
        except Exception as e:
            print("Error checking release:", e)
            pass
        
    map_name_escaped = urllib.parse.quote(map_name)

    response = urlopen(url+map_name_escaped)
    raw_data_json = json.loads(response.read())

    try:
        cur_map_data_json = {
            "website": raw_data_json.get("website", None),
            "type": raw_data_json.get("type", None),
            "mapper": raw_data_json.get("mapper", None),
            "release": raw_data_json.get("release", None),
            "median_time": raw_data_json.get("median_time", None),
            "finishers": raw_data_json.get("finishers", None),
            "median_time": raw_data_json.get("median_time", None),
            "fastest_team_finish": raw_data_json["team_ranks"][0]["time"] if len(raw_data_json["team_ranks"]) > 0 else None,
            "fastest_rank_finish": raw_data_json["ranks"][0]["time"] if len(raw_data_json["ranks"]) > 0 else None,
        }
    except:
        with open("error.txt", "a") as f:
            f.write(map_name+"\n")
        continue
    print(cur_map_data_json)
    
    all_map_json_data[map_name] = cur_map_data_json
    time.sleep(1)


with open("all_map_json_data.json", "w") as f:
    json.dump(all_map_json_data, f)
