import sqlite3
import sys

if len(sys.argv) < 2:
    print("Please pass the path to the sqlite db")

db_path = sys.argv[1]
con = sqlite3.connect(db_path)
cur = con.cursor()
cur.execute("SELECT * FROM (SELECT Name, COUNT(Name) as cof FROM race WHERE SERVER = 'ZAF' GROUP BY Name) WHERE cof > 10 ORDER BY cof DESC")

rows = cur.fetchall()
all_names = []
for name, count in rows:
    name = name.replace('"','\\"')
    print(f"{name}: {count}")
    all_names.append(name)

print(len(rows))

string = 'var zaf_players = ["' + '","'.join(all_names) + '"]'
with open("out.js", "w", encoding="utf-8") as f:
    f.write(string)
