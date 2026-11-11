package com.indexnine.bondpoc;

import com.indexnine.bondpoc.config.AppProperties;
import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.boot.context.properties.EnableConfigurationProperties;

@SpringBootApplication
@EnableConfigurationProperties(AppProperties.class)
public class BondApplication {
    public static void main(String[] args) {
        SpringApplication.run(BondApplication.class, args);
    }
}
