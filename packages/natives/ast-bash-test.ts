import { astMatch } from "@oh-my-pi/pi-natives";

const src = `x=$(python -c "print(1)")
if true; then rm -rf /tmp/x; fi
for f in *.ts; do node -e "1"; done
uv run python -c "x"
git push -f origin main`;

const res = await astMatch({
	source: src,
	lang: "bash",
	patterns: ["python -c $$$ARGS", "rm $$$ARGS", "node -e $$$ARGS", "git $$$ARGS"],
	includeMeta: true,
});
console.log(JSON.stringify(res, null, 2));
