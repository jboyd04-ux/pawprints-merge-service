import express from "express";

const app = express();
app.use(express.json());

app.get("/", (req, res) => {
  res.send("Pawprints merge service is running");
});

app.post("/merge-memory-media", async (req, res) => {
  const { jobId } = req.body;

  if (!jobId) {
    return res.status(400).json({ error: "Missing jobId" });
  }

  console.log("Merge requested for job:", jobId);

  return res.json({
    success: true,
    message: "Merge endpoint reached",
    jobId,
  });
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`Merge service running on port ${PORT}`);
});