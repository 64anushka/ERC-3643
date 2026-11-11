package com.indexnine.bondpoc.api;

import com.indexnine.bondpoc.dto.DeployRequest;
import com.indexnine.bondpoc.service.DeploymentState;
import com.indexnine.bondpoc.service.JobService;
import com.indexnine.bondpoc.service.StateStore;
import io.swagger.v3.oas.annotations.Operation;
import io.swagger.v3.oas.annotations.tags.Tag;
import jakarta.validation.Valid;
import java.util.Map;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/api/deployments")
@Tag(name = "1. Deployment", description = "Phase A + B + whitelist (steps 1-8) and funding of the whitelisted wallets")
public class DeploymentController {
    private final JobService jobs;
    private final StateStore stateStore;

    public DeploymentController(JobService jobs, StateStore stateStore) {
        this.jobs = jobs;
        this.stateStore = stateStore;
    }

    @PostMapping
    @Operation(summary = "Deploy the platform + a deal, whitelist the wallets and fund them (steps 1-8)",
            description = "Starts the deployment in the background and returns a job id immediately (it takes several minutes on Sepolia). "
                    + "Poll GET /api/deployments/jobs/{jobId} for per-step progress; the result contains all deployed addresses.")
    public ResponseEntity<Map<String, Object>> deploy(@Valid @RequestBody DeployRequest request) {
        JobService.Job job = jobs.startDeployment(request);
        return ResponseEntity.status(HttpStatus.ACCEPTED).body(Map.of(
                "jobId", job.id,
                "status", job.status,
                "statusUrl", "/api/deployments/jobs/" + job.id));
    }

    @GetMapping("/jobs/{jobId}")
    @Operation(summary = "Progress / result of a deployment job")
    public JobService.Job job(@PathVariable String jobId) {
        return jobs.get(jobId);
    }

    @GetMapping("/current")
    @Operation(summary = "The latest successful deployment (addresses, whitelist, price)")
    public DeploymentState current() {
        return stateStore.require();
    }
}
